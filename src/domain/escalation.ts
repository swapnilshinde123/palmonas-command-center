import { z } from "zod";
import type { EscalationLevel } from "@prisma/client";
import { prisma, tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { iso, todayBiz } from "@/lib/dates";
import { assertCan, type Actor } from "./rbac";
import { audit } from "./audit";
import { enqueue } from "./notifications/enqueue";
import { grantAccess, loadTask, visibleWhere } from "./task-core";
import { isActive } from "./sla";

// Brief §7: L0 = not escalated. The raiser picks L1/L2/L3; there is no automatic progression.
export const LEVELS: EscalationLevel[] = ["L1", "L2", "L3"];
const HOUR = 3_600_000;

export async function levelOwner(tx: Tx, level: EscalationLevel) {
  return tx.user.findFirst({ where: { escalationLevel: level, status: "ACTIVE" }, select: { id: true, name: true } });
}

export async function escalationOwners() {
  const users = await prisma.user.findMany({ where: { escalationLevel: { not: null } }, select: { id: true, name: true, escalationLevel: true, status: true } });
  return LEVELS.map((l) => {
    const u = users.find((x) => x.escalationLevel === l);
    return { level: l, userId: u?.id ?? null, name: u?.name ?? null, active: u?.status === "ACTIVE" };
  });
}

// L1/L2/L3 owners act on escalations; Admin keeps an override for when an owner is away.
const canAct = (a: Actor) => !!a.escalationLevel || a.role === "ADMIN";

export const triggerSchema = z.object({ level: z.string().nullish(), reason: z.string().nullish() });

export async function triggerEscalation(actor: Actor, taskId: string, body: unknown) {
  const b = triggerSchema.parse(body);
  const errors: Record<string, string> = {};
  if (!b.level || !LEVELS.includes(b.level as EscalationLevel)) errors.level = "Choose who to escalate to: L1, L2 or L3.";
  if (!b.reason?.trim()) errors.reason = "Describe what's blocked and what you need.";
  if (Object.keys(errors).length) throw fail.validation(errors);
  const level = b.level as EscalationLevel;
  const reason = b.reason!.trim();
  return runTx(async (tx) => {
    const task = await loadTask(tx, taskId, actor, { lock: true });
    assertCan(actor, "TRIGGER_ESCALATION", task.ownerId === actor.id || task.createdById === actor.id);
    if (!isActive(task.status)) throw fail.blocked("Only active tasks can be escalated.");
    if (await tx.escalation.findFirst({ where: { taskId, active: true } })) throw fail.conflict("This task already has an active escalation. Reassign it instead.");
    const owner = await levelOwner(tx, level);
    if (!owner) throw fail.blocked(`No active ${level} owner is set up. Ask an admin to assign one in Team.`);
    const esc = await tx.escalation.create({
      data: { taskId, level, assigneeId: owner.id, reason, triggeredById: actor.id, dependencyTier: task.pocType, pendingFrom: task.pendingFrom },
    });
    await tx.escalationLevelChange.create({ data: { escalationId: esc.id, fromLevel: null, toLevel: level, actorId: actor.id, cause: reason } });
    await tx.task.update({ where: { id: taskId }, data: { escalationRequired: true, version: { increment: 1 }, updatedById: actor.id } });
    await grantAccess(tx, taskId, owner.id, "ESCALATION", actor.id);
    if (actor.id !== task.ownerId) await grantAccess(tx, taskId, actor.id, "ESCALATION", actor.id);
    await audit(tx, { recordId: taskId, eventType: "ESCALATION_TRIGGERED", actor, reason, relatedEntityId: esc.id, previousValue: { level: "L0" }, newValue: { level, assigneeId: owner.id } });
    await enqueue(tx, {
      eventType: "ESCALATION_TRIGGERED", transitionId: `${esc.id}:${level}`, taskId, recipientIds: [owner.id, task.ownerId], actorId: actor.id,
      subject: `[${level}] Escalated by ${actor.name}: ${task.name}`,
      payload: { taskId, task: task.name, level, assignee: owner.name, raisedBy: actor.name, reason, priority: `P${task.priority}`, deadline: iso(task.deadline) },
    });
    return { escalationId: esc.id, level, assignee: owner };
  });
}

export async function reassignEscalation(actor: Actor, escId: string, body: unknown) {
  const b = z.object({ level: z.string().nullish(), reason: z.string().nullish() }).parse(body);
  if (!canAct(actor)) throw fail.forbidden("Only L1, L2 or L3 escalation owners can reassign an escalation.");
  const errors: Record<string, string> = {};
  if (!b.level || !LEVELS.includes(b.level as EscalationLevel)) errors.level = "Pick L1, L2 or L3.";
  if (!b.reason?.trim()) errors.reason = "A reason is required to reassign.";
  if (Object.keys(errors).length) throw fail.validation(errors);
  const to = b.level as EscalationLevel;
  return runTx(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Escalation" WHERE "id" = ${escId} FOR UPDATE`;
    const esc = await tx.escalation.findUnique({ where: { id: escId }, include: { task: { select: { id: true, name: true, ownerId: true } } } });
    if (!esc || !esc.active) throw fail.notFound("Active escalation");
    if (esc.level === to) throw fail.validation({ level: `Already at ${to}.` });
    const owner = await levelOwner(tx, to);
    if (!owner) throw fail.blocked(`No active ${to} owner is set up.`);
    await tx.escalation.update({ where: { id: escId }, data: { level: to, assigneeId: owner.id, levelEnteredAt: new Date() } });
    await tx.escalationLevelChange.create({ data: { escalationId: escId, fromLevel: esc.level, toLevel: to, actorId: actor.id, cause: b.reason!.trim() } });
    await grantAccess(tx, esc.taskId, owner.id, "ESCALATION", actor.id);
    await audit(tx, { recordId: esc.taskId, eventType: "ESCALATION_REASSIGNED", actor, reason: b.reason!.trim(), relatedEntityId: escId, previousValue: { level: esc.level, assigneeId: esc.assigneeId }, newValue: { level: to, assigneeId: owner.id } });
    await enqueue(tx, {
      eventType: "ESCALATION_REASSIGNED", transitionId: `${escId}:${to}:${Date.now()}`, taskId: esc.taskId, recipientIds: [owner.id, esc.task.ownerId, esc.assigneeId ?? ""], actorId: actor.id,
      subject: `[${to}] Escalation reassigned from ${esc.level}: ${esc.task.name}`, payload: { taskId: esc.taskId, task: esc.task.name, from: esc.level, to, assignee: owner.name, by: actor.name, reason: b.reason },
    });
    return { ok: true, level: to };
  });
}

export async function respondEscalation(actor: Actor, escId: string, body: unknown) {
  const { note } = z.object({ note: z.string().nullish() }).parse(body);
  if (!note?.trim()) throw fail.validation({ note: "Add a short update." });
  return runTx(async (tx) => {
    const esc = await tx.escalation.findUnique({ where: { id: escId } });
    if (!esc || !esc.active) throw fail.notFound("Active escalation");
    await loadTask(tx, esc.taskId, actor);
    await tx.escalation.update({ where: { id: escId }, data: { lastResponseAt: new Date(), lastResponseById: actor.id } });
    await audit(tx, { recordId: esc.taskId, eventType: "ESCALATION_UPDATE", actor, reason: note.trim(), relatedEntityId: escId });
    return { ok: true };
  });
}

// Resolving closes the escalation only; the task's own status is never changed here (brief §7.7).
export async function resolveEscalation(actor: Actor, escId: string, body: unknown) {
  const { remarks } = z.object({ remarks: z.string().nullish() }).parse(body);
  if (!canAct(actor)) throw fail.forbidden("Only L1, L2 or L3 escalation owners can resolve an escalation.");
  if (!remarks?.trim()) throw fail.validation({ remarks: "Resolution notes are required." });
  return runTx(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Escalation" WHERE "id" = ${escId} FOR UPDATE`;
    const esc = await tx.escalation.findUnique({ where: { id: escId } });
    if (!esc) throw fail.notFound("Escalation");
    if (!esc.active) throw fail.conflict("This escalation is already resolved.");
    await tx.escalation.update({ where: { id: escId }, data: { active: false, resolvedById: actor.id, resolvedAt: new Date(), resolutionRemarks: remarks.trim() } });
    await tx.task.update({ where: { id: esc.taskId }, data: { escalationRequired: false, version: { increment: 1 }, updatedById: actor.id } });
    await audit(tx, { recordId: esc.taskId, eventType: "ESCALATION_RESOLVED", actor, reason: remarks.trim(), relatedEntityId: escId, previousValue: { level: esc.level }, newValue: { level: "L0" } });
    const task = await tx.task.findUniqueOrThrow({ where: { id: esc.taskId }, select: { ownerId: true, name: true } });
    await enqueue(tx, { eventType: "ESCALATION_RESOLVED", transitionId: escId, taskId: esc.taskId, recipientIds: [task.ownerId, esc.triggeredById], actorId: actor.id, subject: `Escalation resolved: ${task.name}`, payload: { taskId: esc.taskId, by: actor.name, reason: remarks } });
    return { ok: true };
  });
}

const PRIORITY_RANK = (p: number) => p;

export async function escalationsView(actor: Actor, raw: unknown) {
  const f = z.object({ level: z.string().optional(), mine: z.string().optional(), resolution: z.enum(["active", "resolved"]).optional() }).parse(raw ?? {});
  const resolved = f.resolution === "resolved";
  const rows = await prisma.escalation.findMany({
    where: {
      active: !resolved,
      ...(resolved ? { resolvedAt: { gte: new Date(Date.now() - 90 * 86_400_000) } } : {}),
      ...(f.level ? { level: f.level as EscalationLevel } : {}),
      ...(f.mine === "true" ? { assigneeId: actor.id } : {}),
      task: { softDeleted: false, ...visibleWhere(actor) },
    },
    include: {
      task: { select: { id: true, name: true, priority: true, status: true, deadline: true, owner: { select: { id: true, name: true } }, channel: { select: { name: true } } } },
      levelChanges: { orderBy: { at: "asc" } },
    },
  });
  const users = Object.fromEntries((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const today = todayBiz();
  const now = Date.now();
  // Sort: level (L3 first), then priority, then overdue, then oldest.
  const lvl = { L3: 0, L2: 1, L1: 2 } as const;
  rows.sort((a, b) => lvl[a.level] - lvl[b.level] || PRIORITY_RANK(a.task.priority) - PRIORITY_RANK(b.task.priority) || a.task.deadline.getTime() - b.task.deadline.getTime() || a.triggeredAt.getTime() - b.triggeredAt.getTime());
  return {
    canAct: canAct(actor),
    owners: await escalationOwners(),
    rows: rows.map((e) => ({
      id: e.id, level: e.level, active: e.active, reason: e.reason, assigneeId: e.assigneeId, assignee: users[e.assigneeId ?? ""] ?? "—",
      raisedBy: users[e.triggeredById] ?? "—", triggeredAt: e.triggeredAt.toISOString(), resolvedAt: e.resolvedAt?.toISOString() ?? null,
      resolutionRemarks: e.resolutionRemarks, resolvedBy: e.resolvedById ? users[e.resolvedById] : null,
      lastUpdateAt: (e.lastResponseAt ?? e.levelEnteredAt).toISOString(),
      hoursOpen: Math.floor(((e.resolvedAt?.getTime() ?? now) - e.triggeredAt.getTime()) / HOUR),
      history: e.levelChanges.map((c) => ({ from: c.fromLevel ?? "L0", to: c.toLevel, at: c.at.toISOString(), by: users[c.actorId ?? ""] ?? "system", cause: c.cause })),
      task: { ...e.task, deadline: iso(e.task.deadline), overdue: isActive(e.task.status) && e.task.deadline < today },
    })),
  };
}
