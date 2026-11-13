import { z } from "zod";
import type { DepTier, Prisma } from "@prisma/client";
import { prisma, tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { iso, todayBiz } from "@/lib/dates";
import { can as canPerm } from "./actor";
import { isPrivileged, type Actor } from "./rbac";
import { audit } from "./audit";
import { enqueue } from "./notifications/enqueue";
import { DEP_LABEL, DEP_TIERS, loadTask, taskInclude, toDTO, visibleWhere } from "./task-core";
import { ACTIVE_STATUSES } from "./sla";

export interface PendingInput {
  pocType?: string | null;
  pocId?: string | null;
  pendingFrom?: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Brief §6: optional when nothing is pending; once pending, POC Type and POC Name are both mandatory.
// A registry pocId supplies the name; otherwise the typed name becomes a custom POC scoped to the task.
export async function resolvePending(tx: Tx, input: PendingInput, errors: Record<string, string>, taskId?: string) {
  const type = input.pocType?.trim() || null;
  const name = input.pendingFrom?.trim() || null;
  const out = { pocType: null as DepTier | null, pocId: null as string | null, pendingFrom: null as string | null, custom: false };
  if (!type && !name && !input.pocId) return out;
  if (!type) errors.pocType = "Pick a POC Type: Internal, Within Brand or External.";
  else if (!DEP_TIERS.includes(type as DepTier)) errors.pocType = "POC Type must be Internal, Within Brand or External.";
  if (input.pocId) {
    const poc = await tx.poc.findFirst({ where: { id: input.pocId, active: true, OR: [{ isRegistry: true }, ...(taskId ? [{ taskId }] : [])] } });
    if (!poc) errors.pendingFrom = "That POC is no longer available. Pick another or type a name.";
    else if (type && poc.type !== type) errors.pendingFrom = `${poc.name} is a ${DEP_LABEL[poc.type]} POC.`;
    else return { pocType: poc.type, pocId: poc.id, pendingFrom: poc.name, custom: false };
    return out;
  }
  if (!name) errors.pendingFrom = "POC Name is required when the task is pending.";
  else if (name.length > 120) errors.pendingFrom = "Keep the POC name under 120 characters.";
  if (errors.pocType || errors.pendingFrom) return out;
  // Reuse an exact registry match so the same person isn't stored twice.
  const match = await tx.poc.findFirst({ where: { isRegistry: true, active: true, type: type as DepTier, name: { equals: name!, mode: "insensitive" } } });
  if (match) return { pocType: match.type, pocId: match.id, pendingFrom: match.name, custom: false };
  return { pocType: type as DepTier, pocId: null, pendingFrom: name, custom: true };
}

export async function listRegistry(actor: Actor, raw: unknown) {
  void actor;
  const f = z.object({ type: z.string().optional(), q: z.string().optional() }).parse(raw ?? {});
  const rows = await prisma.poc.findMany({
    where: { isRegistry: true, active: true, ...(f.type ? { type: f.type as DepTier } : {}), ...(f.q ? { name: { contains: f.q, mode: "insensitive" } } : {}) },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: { id: true, name: true, type: true, organisation: true, contact: true },
  });
  return rows;
}

// Similar registry names, shown before submitting a custom POC or approving a promotion.
export async function duplicateSuggestions(name: string, type?: DepTier | null) {
  const n = norm(name);
  if (n.length < 2) return [];
  const all = await prisma.poc.findMany({ where: { isRegistry: true, active: true, ...(type ? { type } : {}) }, select: { id: true, name: true, type: true, organisation: true } });
  const words = n.split(" ");
  return all.filter((p) => {
    const m = norm(p.name);
    return m === n || m.includes(n) || n.includes(m) || words.some((w) => w.length > 2 && m.split(" ").includes(w));
  }).slice(0, 8);
}

export async function suggest(actor: Actor, raw: unknown) {
  void actor;
  const f = z.object({ name: z.string(), type: z.string().nullish() }).parse(raw ?? {});
  return duplicateSuggestions(f.name, (f.type || null) as DepTier | null);
}

// ---------- Promotion: custom → registry, L1 (Ritesh) only, with the non-duplicate declaration ----------

export async function requestPromotion(actor: Actor, pocId: string, body: unknown) {
  const b = z.object({ organisation: z.string().nullish(), contact: z.string().nullish() }).parse(body ?? {});
  return runTx(async (tx) => {
    const poc = await tx.poc.findUnique({ where: { id: pocId } });
    if (!poc || poc.isRegistry || !poc.taskId) throw fail.notFound("Custom POC");
    await loadTask(tx, poc.taskId, actor);
    if (poc.promotionRequestedAt && !poc.promotionRejectedAt) throw fail.conflict("Promotion is already awaiting L1 approval.");
    await tx.poc.update({
      where: { id: pocId },
      data: { promotionRequestedAt: new Date(), promotionRequestedById: actor.id, promotionRejectedAt: null, promotionRejectReason: null, organisation: b.organisation?.trim() ?? poc.organisation, contact: b.contact?.trim() ?? poc.contact },
    });
    await audit(tx, { recordId: poc.taskId, eventType: "POC_PROMOTION_REQUESTED", actor, relatedEntityId: pocId, newValue: { name: poc.name, type: poc.type } });
    const l1 = await tx.user.findFirst({ where: { escalationLevel: "L1", status: "ACTIVE" } });
    // Notification carries no task detail: L1 approves from the POC queue, not the task.
    if (l1) await tx.inAppNotification.createMany({ data: [{ userId: l1.id, eventType: "POC_PROMOTION_REQUESTED", title: `POC awaiting registry approval: ${poc.name} (${DEP_LABEL[poc.type]})`, dedupKey: `POC_PROMOTION_REQUESTED:${pocId}:${Date.now()}` }], skipDuplicates: true });
    return { ok: true };
  });
}

const isL1 = (a: Actor) => a.escalationLevel === "L1";

export async function promotionQueue(actor: Actor) {
  if (!isL1(actor) && !isPrivileged(actor)) throw fail.forbidden("Only L1 can review POC promotions.");
  const rows = await prisma.poc.findMany({ where: { isRegistry: false, promotionRequestedAt: { not: null }, promotionRejectedAt: null, active: true }, orderBy: { promotionRequestedAt: "asc" } });
  const users = Object.fromEntries((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return Promise.all(rows.map(async (p) => ({
    id: p.id, name: p.name, type: p.type, typeLabel: DEP_LABEL[p.type], organisation: p.organisation, contact: p.contact,
    requestedBy: users[p.promotionRequestedById ?? ""] ?? "—", requestedAt: p.promotionRequestedAt!.toISOString(),
    duplicates: await duplicateSuggestions(p.name, null), canDecide: isL1(actor),
  })));
}

export async function decidePromotion(actor: Actor, pocId: string, body: unknown) {
  const b = z.object({ decision: z.enum(["APPROVE", "REJECT"]), verifiedNotDuplicate: z.boolean().optional(), name: z.string().nullish(), reason: z.string().nullish() }).parse(body);
  if (!isL1(actor)) throw fail.forbidden("Only the L1 escalation owner can approve POC promotions.");
  return runTx(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Poc" WHERE "id" = ${pocId} FOR UPDATE`;
    const poc = await tx.poc.findUnique({ where: { id: pocId } });
    if (!poc || poc.isRegistry || !poc.promotionRequestedAt || poc.promotionRejectedAt) throw fail.conflict("This POC isn't awaiting approval.");
    if (b.decision === "REJECT") {
      if (!b.reason?.trim()) throw fail.validation({ reason: "Say why, so the requester can fix it." });
      await tx.poc.update({ where: { id: pocId }, data: { promotionRejectedAt: new Date(), promotionRejectReason: b.reason.trim() } });
      await audit(tx, { recordId: poc.taskId ?? pocId, eventType: "POC_PROMOTION_REJECTED", actor, relatedEntityId: pocId, reason: b.reason.trim() });
    } else {
      if (b.verifiedNotDuplicate !== true) throw fail.validation({ verifiedNotDuplicate: "Tick “I have verified that this is not a duplicate entry.” to approve." });
      const canonical = b.name?.trim() || poc.name;
      if (await tx.poc.findFirst({ where: { isRegistry: true, active: true, type: poc.type, name: { equals: canonical, mode: "insensitive" } } }))
        throw fail.validation({ name: "A registry POC with this exact name and type already exists." });
      // The custom row becomes the registry row, so the originating task keeps its link.
      await tx.poc.update({ where: { id: pocId }, data: { isRegistry: true, taskId: null, name: canonical, promotedAt: new Date(), promotedById: actor.id, verifiedNotDuplicate: true } });
      await tx.task.updateMany({ where: { pocId }, data: { pendingFrom: canonical } });
      await audit(tx, { recordId: poc.taskId ?? pocId, eventType: "POC_PROMOTED", actor, relatedEntityId: pocId, newValue: { name: canonical, type: poc.type, verifiedNotDuplicate: true } });
    }
    if (poc.promotionRequestedById && poc.promotionRequestedById !== actor.id)
      await tx.inAppNotification.create({ data: { userId: poc.promotionRequestedById, eventType: "POC_PROMOTION_DECIDED", title: `POC ${b.decision === "APPROVE" ? "added to registry" : "not added"}: ${poc.name}`, body: b.reason ?? "", dedupKey: `POC_PROMOTION_DECIDED:${pocId}:${Date.now()}` } });
    return { ok: true };
  });
}

// Registry maintenance by settings managers; deactivate rather than delete so history resolves.
export async function upsertRegistryPoc(actor: Actor, id: string | null, body: unknown) {
  if (!canPerm(actor, "settings.manage") && !isL1(actor)) throw fail.forbidden();
  const b = z.object({ name: z.string().trim().min(2).max(120).optional(), type: z.enum(["I", "WB", "E"]).optional(), organisation: z.string().optional(), contact: z.string().optional(), active: z.boolean().optional() }).parse(body);
  return runTx(async (tx) => {
    if (id) {
      const r = await tx.poc.update({ where: { id }, data: b });
      await audit(tx, { recordId: id, entityType: "CONFIG", eventType: "POC_UPDATED", actor, newValue: b });
      return r;
    }
    if (!b.name || !b.type) throw fail.validation({ name: "Name and type are required." });
    if (await tx.poc.findFirst({ where: { isRegistry: true, active: true, type: b.type, name: { equals: b.name, mode: "insensitive" } } })) throw fail.validation({ name: "Already in the registry." });
    const r = await tx.poc.create({ data: { name: b.name, type: b.type, organisation: b.organisation ?? "", contact: b.contact ?? "", isRegistry: true, createdById: actor.id, promotedById: actor.id, promotedAt: new Date(), verifiedNotDuplicate: true } });
    await audit(tx, { recordId: r.id, entityType: "CONFIG", eventType: "POC_CREATED", actor, newValue: b });
    return r;
  });
}

// ---------- Pending From view (brief §6): what are we waiting for, and from whom ----------

export async function pendingFromView(actor: Actor, raw: unknown) {
  const f = z.object({ type: z.string().optional(), view: z.enum(["mine", "team", "shared"]).optional() }).parse(raw ?? {});
  const view = f.view ?? (isPrivileged(actor) ? "team" : "mine");
  if (view === "team" && !isPrivileged(actor)) throw fail.forbidden();
  const where: Prisma.TaskWhereInput = {
    AND: [visibleWhere(actor), { softDeleted: false, status: { in: ACTIVE_STATUSES }, pocType: f.type ? (f.type as DepTier) : { not: null } }, ...(view === "mine" ? [{ ownerId: actor.id }] : [])],
  };
  const [rows, counts] = await Promise.all([
    prisma.task.findMany({ where, include: taskInclude, orderBy: [{ pendingSince: "asc" }, { priority: "asc" }] }),
    prisma.task.groupBy({ by: ["pocType"], where: { AND: [visibleWhere(actor), { softDeleted: false, status: { in: ACTIVE_STATUSES }, pocType: { not: null } }, ...(view === "mine" ? [{ ownerId: actor.id }] : [])] }, _count: true }),
  ]);
  const today = todayBiz();
  return {
    view,
    counts: Object.fromEntries(counts.map((c) => [c.pocType!, c._count])),
    rows: rows.map((t) => ({ ...toDTO(t, today, actor), followupDue: !!t.followupDate && t.followupDate <= today, followupDateIso: iso(t.followupDate) })),
  };
}

export { loadTask };
