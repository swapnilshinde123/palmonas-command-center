import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, tx as runTx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { CONFIG_DEFAULTS, getAllConfig, getConfig } from "@/lib/config";
import { assertCan as assertPerm } from "./actor";
import { escalationOwners } from "./escalation";
import { tryParseISODate, iso } from "@/lib/dates";
import { assertCan, can, isPrivileged, MATRIX, type Actor } from "./rbac";
import { audit } from "./audit";
import { TASK_ID_RE } from "./ids";
import { reconcile } from "./metrics";
import { retryDead } from "./notifications/processor";
import { mailMode } from "./notifications/mailer";
import { visibleWhere } from "./task-core";

export async function meta(actor: Actor) {
  const [users, channels, workstreams, projects, owners] = await Promise.all([
    prisma.user.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true, escalationLevel: true } }),
    prisma.channel.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.workstream.findMany({ orderBy: { name: "asc" } }),
    prisma.project.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, status: true } }),
    escalationOwners(),
  ]);
  return {
    users, channels, workstreams, projects, escalationOwners: owners,
    tier: actor.role, privileged: isPrivileged(actor), escalationLevel: actor.escalationLevel,
    perms: Object.fromEntries(Object.keys(MATRIX).map((k) => [k, MATRIX[k as keyof typeof MATRIX][actor.role]])),
    dueSoon: await getConfig("dueSoon"),
  };
}

export async function upsertList(actor: Actor, kind: "channel" | "workstream", id: string | null, body: unknown) {
  assertPerm(actor, "settings.manage");
  const b = z.object({ name: z.string().trim().min(2).max(60).optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional() }).parse(body);
  return runTx(async (tx) => {
    // Values are deactivated, never deleted, so historical tasks keep resolving (§23.2).
    const r = kind === "channel"
      ? id ? await tx.channel.update({ where: { id }, data: b }) : await tx.channel.create({ data: { name: b.name!, sortOrder: b.sortOrder ?? 99 } })
      : id ? await tx.workstream.update({ where: { id }, data: { name: b.name, active: b.active } }) : await tx.workstream.create({ data: { name: b.name! } });
    await audit(tx, { recordId: r.id, entityType: "CONFIG", eventType: `${kind.toUpperCase()}_${id ? "UPDATED" : "CREATED"}`, actor, newValue: b });
    return r;
  });
}

export async function setHoliday(actor: Actor, body: unknown) {
  assertPerm(actor, "settings.manage");
  const b = z.object({ date: z.string(), name: z.string().nullish(), remove: z.boolean().optional() }).parse(body);
  const d = tryParseISODate(b.date);
  if (!d) throw fail.validation({ date: "Enter a valid date." });
  return runTx(async (tx) => {
    if (b.remove) await tx.holiday.delete({ where: { date: d } });
    else await tx.holiday.upsert({ where: { date: d }, create: { date: d, name: b.name ?? "Holiday" }, update: { name: b.name ?? "Holiday" } });
    await audit(tx, { recordId: b.date, entityType: "CONFIG", eventType: b.remove ? "HOLIDAY_REMOVED" : "HOLIDAY_SET", actor, newValue: b });
    return { ok: true };
  });
}

export async function setConfig(actor: Actor, body: unknown) {
  assertPerm(actor, "settings.manage");
  const b = z.object({ key: z.string(), value: z.record(z.unknown()) }).parse(body);
  if (!(b.key in CONFIG_DEFAULTS)) throw fail.validation({ key: "Unknown setting." });
  const def = (CONFIG_DEFAULTS as Record<string, unknown>)[b.key];
  if (typeof def === "object" && def) for (const k of Object.keys(b.value)) if (!(k in def)) throw fail.validation({ [k]: "Unknown field." });
  if (b.key === "exclusionGate") { try { new RegExp(String(b.value.pattern)); } catch { throw fail.validation({ pattern: "Invalid regular expression." }); } }
  return runTx(async (tx) => {
    const before = await tx.appConfig.findUnique({ where: { key: b.key } });
    await tx.appConfig.upsert({ where: { key: b.key }, create: { key: b.key, value: b.value as Prisma.InputJsonValue, updatedBy: actor.id }, update: { value: b.value as Prisma.InputJsonValue, updatedBy: actor.id } });
    await audit(tx, { recordId: b.key, entityType: "CONFIG", eventType: "CONFIG_CHANGED", actor, previousValue: before?.value ?? def, newValue: b.value });
    if (b.key === "notifications" && (before?.value as { emailDelivery?: string } | undefined)?.emailDelivery !== b.value.emailDelivery)
      await audit(tx, { recordId: "email-delivery", entityType: "NOTIFICATION", eventType: b.value.emailDelivery === "ON" ? "EMAIL_DELIVERY_ENABLED" : "EMAIL_DELIVERY_DISABLED", actor });
    if (b.key === "exclusionGate") {
      // Re-evaluate the gate for all tasks so KPIs reflect the approved rule immediately.
      const re = new RegExp(String(b.value.pattern), "i");
      const tasks = await tx.task.findMany({ select: { id: true, name: true, excludedFromMetrics: true } });
      for (const t of tasks) {
        const ex = re.test(t.name.trim());
        if (ex !== t.excludedFromMetrics) await tx.task.update({ where: { id: t.id }, data: { excludedFromMetrics: ex } });
      }
    }
    return { ok: true };
  });
}

export async function adminOverview(actor: Actor) {
  assertPerm(actor, "settings.manage");
  const [config, holidays, users, channels, workstreams, slaPolicies, policies, heartbeats] = await Promise.all([
    getAllConfig(), prisma.holiday.findMany({ orderBy: { date: "asc" } }), prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true, escalationLevel: true, status: true } }),
    prisma.channel.findMany({ orderBy: [{ sortOrder: "asc" }] }), prisma.workstream.findMany({ orderBy: { name: "asc" } }),
    prisma.slaPolicy.findMany({ orderBy: { rank: "asc" } }), prisma.scorePolicy.findMany({ orderBy: { version: "desc" } }),
    prisma.workerHeartbeat.findMany({ where: { name: { startsWith: "job:" } } }),
  ]);
  return { config, holidays: holidays.map((h) => ({ ...h, date: iso(h.date) })), users, channels, workstreams, slaPolicies, scorePolicies: policies, heartbeats, mailMode: mailMode() };
}

export async function notificationQueue(actor: Actor, status?: string) {
  assertPerm(actor, "emails.view");
  const where = status ? { status: status as never } : {};
  const [rows, counts] = await Promise.all([
    prisma.notificationEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.notificationEvent.groupBy({ by: ["status"], _count: true }),
  ]);
  return { rows, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
}

export async function retryNotifications(actor: Actor, body: unknown) {
  assertPerm(actor, "emails.view");
  const { ids } = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(body);
  const r = await retryDead(ids);
  await runTx((tx) => audit(tx, { recordId: "notification-queue", entityType: "NOTIFICATION", eventType: "NOTIFICATIONS_RETRIED", actor, newValue: { ids } }));
  return { requeued: r.count };
}

// §36.5 admin report + §18.5 reconciliation.
export async function integrityReport(actor: Actor) {
  assertPerm(actor, "settings.manage");
  const ids = await prisma.task.findMany({ select: { id: true, legacyId: true } });
  const malformed = ids.filter((t) => !TASK_ID_RE.test(t.id)).map((t) => t.id);
  const seen = new Map<string, number>();
  for (const t of ids) seen.set(t.id.toUpperCase(), (seen.get(t.id.toUpperCase()) ?? 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  const extMismatch = await prisma.$queryRaw<{ id: string; stored: number; actual: bigint }[]>`
    SELECT t.id, t."extensionsCount" AS stored, count(e.id) AS actual FROM "Task" t
    LEFT JOIN "ExtensionRequest" e ON e."taskId" = t.id AND e.status = 'APPROVED'
    GROUP BY t.id HAVING t."extensionsCount" <> count(e.id)`;
  const waiverMismatch = await prisma.$queryRaw<{ id: string; stored: number; actual: bigint }[]>`
    SELECT t.id, t."waivedExtensionsCount" AS stored, count(w.id) AS actual FROM "Task" t
    LEFT JOIN "ExtensionRequest" e ON e."taskId" = t.id AND e.status = 'APPROVED'
    LEFT JOIN "WaiverRequest" w ON w."extensionId" = e.id AND w.status = 'APPROVED'
    GROUP BY t.id HAVING t."waivedExtensionsCount" <> count(w.id)`;
  const escMismatch = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM "Task" t WHERE t."escalationRequired" <> EXISTS (SELECT 1 FROM "Escalation" e WHERE e."taskId" = t.id AND e.active)`;
  const orphanSubtasks = await prisma.subtask.count({ where: { status: { in: ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"] }, task: { OR: [{ softDeleted: true }, { status: { in: ["COMPLETED", "DROPPED"] } }] } } });
  return {
    taskCount: ids.length, malformedIds: malformed.filter((id) => !ids.find((t) => t.id === id)?.legacyId), legacyIds: ids.filter((t) => t.legacyId).length, duplicateIds: duplicates,
    extensionCounterMismatches: extMismatch.map((r) => ({ ...r, actual: Number(r.actual) })),
    waiverCounterMismatches: waiverMismatch.map((r) => ({ ...r, actual: Number(r.actual) })),
    escalationFlagMismatches: escMismatch.map((r) => r.id),
    openSubtasksUnderClosedParents: orphanSubtasks,
    kpiReconciliation: await reconcile(),
    notificationsDead: await prisma.notificationEvent.count({ where: { status: "DEAD" } }),
    seriesOpenExceptions: await prisma.seriesException.count({ where: { resolved: false } }),
  };
}

export async function auditLog(actor: Actor, raw: unknown) {
  const f = z.object({ recordId: z.string().optional(), eventType: z.string().optional(), actorId: z.string().optional(), limit: z.coerce.number().int().max(1000).optional() }).parse(raw ?? {});
  if (!isPrivileged(actor)) {
    // Members: only history of tasks they can currently see.
    if (!f.recordId) throw fail.forbidden("Pick a task to view its history.");
    const taskId = f.recordId.replace(/-S\d+$/, "");
    if (!(await prisma.task.findFirst({ where: { id: taskId, ...visibleWhere(actor) } }))) throw fail.notFound("Task");
  }
  assertCan(actor, "VIEW_AUDIT", true);
  const rows = await prisma.auditEvent.findMany({
    where: { ...(f.recordId ? { recordId: { startsWith: f.recordId } } : {}), ...(f.eventType ? { eventType: f.eventType } : {}), ...(f.actorId ? { actorId: f.actorId } : {}) },
    orderBy: { seq: "desc" }, take: f.limit ?? 300,
  });
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}

export { can };
