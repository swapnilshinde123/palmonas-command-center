import type { Prisma, Task, TaskStatus, DepTier } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { iso, todayBiz } from "@/lib/dates";
import { CONFIG_DEFAULTS, exclusionMatcher, getConfig } from "@/lib/config";
import { isPrivileged, type Actor } from "./rbac";
import { agingDays, daysOverdue, tatDays, timeliness, TIMELINESS_LABEL } from "./sla";

export const taskInclude = {
  channel: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } },
  workstream: { select: { id: true, name: true } },
  subtasks: { select: { id: true, status: true, ownerId: true, required: true } },
  escalations: { where: { active: true }, select: { id: true, level: true, triggeredAt: true, assigneeId: true } },
  poc: { select: { id: true, name: true, type: true, isRegistry: true } },
  transfers: { where: { status: "PENDING" as const }, select: { id: true, toUserId: true, fromUserId: true } },
  extensions: { where: { status: "PENDING" as const }, select: { id: true, requestedDeadline: true } },
} satisfies Prisma.TaskInclude;

export type TaskWithRefs = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

// Brief §2: Admin/Leadership see everything; members see tasks they own plus tasks where a
// contextual relationship is recorded in TaskAccess (scoped to that task only, revocable).
export function visibleWhere(actor: Actor): Prisma.TaskWhereInput {
  if (isPrivileged(actor)) return {};
  const or: Prisma.TaskWhereInput[] = [{ ownerId: actor.id }, { access: { some: { userId: actor.id, revokedAt: null } } }];
  // L1/L2/L3 owners may reassign any active escalation (brief §7), so they can open escalated tasks while active.
  if (actor.escalationLevel) or.push({ escalations: { some: { active: true } } });
  return { OR: or };
}

export type AccessReason = "CREATOR" | "PREVIOUS_OWNER" | "TRANSFER" | "EXTENSION" | "WAIVER" | "ESCALATION" | "COLLABORATOR" | "SUBTASK";

// Idempotent; re-grants a previously revoked relationship.
export async function grantAccess(tx: Tx, taskId: string, userId: string | null | undefined, reason: AccessReason, grantedById: string | null) {
  if (!userId) return;
  await tx.taskAccess.upsert({
    where: { taskId_userId_reason: { taskId, userId, reason } },
    create: { taskId, userId, reason, grantedById },
    update: { revokedAt: null, revokedById: null },
  });
}

export async function canSeeTask(db: Tx, actor: Actor, taskId: string) {
  return !!(await db.task.findFirst({ where: { id: taskId, ...visibleWhere(actor) }, select: { id: true } }));
}

export async function loadTask(tx: Tx, id: string, actor: Actor, opts: { lock?: boolean; allowDeleted?: boolean } = {}) {
  if (opts.lock) await tx.$executeRaw`SELECT 1 FROM "Task" WHERE "id" = ${id} FOR UPDATE`;
  const task = await tx.task.findFirst({ where: { id, ...visibleWhere(actor) }, include: taskInclude });
  if (!task) throw fail.notFound("Task");
  if (task.softDeleted && !opts.allowDeleted) throw fail.blocked("This task is in the Recycle Bin. Restore it first.");
  return task;
}

export const isOwner = (task: Pick<Task, "ownerId">, actor: Actor) => task.ownerId === actor.id;

// Optimistic concurrency (spec §15.2): the write only lands if nobody else bumped the version.
export async function versionedUpdate(tx: Tx, id: string, expectedVersion: number, actor: Actor | null, data: Prisma.TaskUncheckedUpdateManyInput) {
  const r = await tx.task.updateMany({
    where: { id, version: expectedVersion },
    data: { ...data, version: { increment: 1 }, updatedById: actor?.id ?? "system" },
  });
  if (r.count === 0) {
    const latest = await tx.task.findUnique({ where: { id }, include: taskInclude });
    if (!latest) throw fail.notFound("Task");
    throw fail.stale(toDTO(latest));
  }
}

export async function isExcludedName(tx: Tx, name: string) {
  const gate = await getConfig("exclusionGate", tx);
  return exclusionMatcher(gate.pattern)(name);
}

export function validateUrl(v: string | null | undefined): string | null {
  if (v == null || v.trim() === "") return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http(s) links are allowed.";
    return null;
  } catch {
    return "Enter a valid URL starting with https://";
  }
}

export const DEP_TIERS: DepTier[] = ["I", "WB", "E"];
export const DEP_LABEL: Record<DepTier, string> = { I: "Internal", WB: "Within Brand", E: "External" };
export const POC_TYPES = DEP_TIERS;
export const POC_TYPE_LABEL = DEP_LABEL;
export const STATUS_LABEL: Record<TaskStatus, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  ON_HOLD: "On hold",
  COMPLETED: "Completed",
  DROPPED: "Dropped",
};

export async function resolveSlaPolicy(tx: Tx, priority: number, channelName: string): Promise<string | null> {
  const policies = await tx.slaPolicy.findMany({ where: { active: true }, orderBy: { rank: "asc" } });
  for (const p of policies) {
    const r = p.rules as { matchPriorities?: number[]; matchChannels?: string[] };
    if (r.matchPriorities?.length && !r.matchPriorities.includes(priority)) continue;
    if (r.matchChannels?.length && !r.matchChannels.includes(channelName)) continue;
    return p.id;
  }
  return null;
}

// Star state is Admin/Leadership-only (brief §4); hidden unless the viewer is privileged.
export function toDTO(t: TaskWithRefs, today: Date = todayBiz(), viewer?: Actor | null) {
  const tl = timeliness(t, today);
  const requiredSubs = t.subtasks.filter((s) => s.required && s.status !== "DROPPED");
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    channel: t.channel,
    owner: t.owner,
    project: t.project,
    workstream: t.workstream,
    priority: t.priority,
    status: t.status,
    statusLabel: STATUS_LABEL[t.status],
    assignedDate: iso(t.assignedDate),
    deadline: iso(t.deadline),
    originalDeadline: iso(t.originalDeadline),
    followupDate: iso(t.followupDate),
    pendingFrom: t.pendingFrom,
    pocType: t.pocType,
    pocTypeLabel: t.pocType ? DEP_LABEL[t.pocType] : null,
    poc: t.poc,
    pendingSince: t.pendingSince?.toISOString() ?? null,
    remarks: t.remarks,
    outputLink: t.outputLink,
    escalationRequired: t.escalationRequired,
    escalationLevel: t.escalations[0]?.level ?? "L0",
    escalationAssigneeId: t.escalations[0]?.assigneeId ?? null,
    flagged: t.flagged,
    starred: viewer && isPrivileged(viewer) ? t.starred : false,
    createdById: t.createdById,
    revenueCritical: t.revenueCritical,
    timeliness: tl,
    timelinessLabel: TIMELINESS_LABEL[tl],
    agingDays: agingDays(t, today),
    tatDays: tatDays(t),
    daysOverdue: daysOverdue(t, today),
    extensionsCount: t.extensionsCount,
    waivedExtensionsCount: t.waivedExtensionsCount,
    completedAt: t.completedAt?.toISOString() ?? null,
    softDeleted: t.softDeleted,
    deletedAt: t.deletedAt?.toISOString() ?? null,
    deletionReason: t.deletionReason,
    excludedFromMetrics: t.excludedFromMetrics,
    seriesId: t.seriesId,
    occurrenceNumber: t.occurrenceNumber,
    slaPolicyId: t.slaPolicyId,
    subtasks: { total: t.subtasks.length, done: t.subtasks.filter((s) => s.status === "COMPLETED").length, readyForCompletion: requiredSubs.length > 0 && requiredSubs.every((s) => s.status === "COMPLETED") },
    pendingTransfer: t.transfers[0] ?? null,
    pendingExtension: t.extensions[0] ? { id: t.extensions[0].id, requestedDeadline: iso(t.extensions[0].requestedDeadline) } : null,
    updatedAt: t.updatedAt.toISOString(),
    version: t.version,
  };
}

export type TaskDTO = ReturnType<typeof toDTO>;

// Admin-only view equivalent to the legacy Column L metadata JSON (spec §23.4, §29 "View raw Column L JSON").
export function legacyMetadataView(t: Task & { subtasks?: { id: string; status: TaskStatus; ownerId: string | null }[] }, escalationLevel: string | null) {
  return {
    taskId: t.id,
    taskType: t.seriesId ? "recurring" : "non-recurring",
    project: t.projectId,
    softDeleted: t.softDeleted,
    deletedAt: t.deletedAt?.toISOString() ?? null,
    deletedBy: t.deletedById,
    deletionReason: t.deletionReason,
    originalDeadline: iso(t.originalDeadline),
    extensionsCount: t.extensionsCount,
    waivedExtensionsCount: t.waivedExtensionsCount,
    escalationLevel,
    pendingTier: t.pocType,
    seriesId: t.seriesId,
    occurrenceNumber: t.occurrenceNumber,
    clonedFrom: t.clonedFromId,
    slaPolicyId: t.slaPolicyId,
    legacyId: t.legacyId,
    extra: t.extra,
    schemaVersion: 1,
  };
}

export { CONFIG_DEFAULTS };
