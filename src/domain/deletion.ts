import { z } from "zod";
import { prisma, tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { iso, monthKey, businessDateOf } from "@/lib/dates";
import { assertCan, can, type Actor } from "./rbac";
import { audit } from "./audit";
import { loadTask, taskInclude, toDTO } from "./task-core";
import { enqueue } from "./notifications/enqueue";

export async function softDeleteInTx(tx: Tx, actor: Actor, id: string, reason: string) {
  const task = await loadTask(tx, id, actor, { lock: true });
  const open = await tx.subtask.count({ where: { taskId: id, status: { in: ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"] } } });
  await tx.task.update({
    where: { id },
    data: { softDeleted: true, deletedAt: new Date(), deletedById: actor.id, deletionReason: reason, version: { increment: 1 }, updatedById: actor.id },
  });
  // Pending requests on a binned task would otherwise sit in approval queues forever.
  const now = new Date();
  await tx.transfer.updateMany({ where: { taskId: id, status: "PENDING" }, data: { status: "CANCELLED", decidedById: actor.id, decidedAt: now, rejectionReason: "Task moved to bin" } });
  await tx.extensionRequest.updateMany({ where: { taskId: id, status: "PENDING" }, data: { status: "CANCELLED", decidedById: actor.id, decidedAt: now, decisionReason: "Task moved to bin" } });
  await audit(tx, { recordId: id, eventType: "TASK_SOFT_DELETED", actor, reason, previousValue: { softDeleted: false, status: task.status }, newValue: { softDeleted: true, openSubtasksRetained: open } });
  await enqueue(tx, { eventType: "TASK_BINNED", transitionId: `bin-${task.version}`, taskId: id, recipientIds: [task.ownerId], actorId: actor.id, subject: `Moved to Bin by ${actor.name}: ${task.name}`, payload: { taskId: id, reason } });
}

export async function softDelete(actor: Actor, id: string, body: unknown) {
  const { reason } = z.object({ reason: z.string().nullish() }).parse(body);
  if (!reason?.trim()) throw fail.validation({ reason: "A reason is required to move a task to the bin." });
  return runTx(async (tx) => {
    assertCan(actor, "SOFT_DELETE");
    await softDeleteInTx(tx, actor, id, reason.trim());
    return { ok: true };
  });
}

export async function restore(actor: Actor, id: string, body: unknown) {
  const { reason } = z.object({ reason: z.string().nullish() }).parse(body);
  if (!reason?.trim()) throw fail.validation({ reason: "A reason is required to restore." });
  return runTx(async (tx) => {
    assertCan(actor, "RESTORE");
    const task = await loadTask(tx, id, actor, { lock: true, allowDeleted: true });
    if (!task.softDeleted) throw fail.conflict("Task is not in the bin.");
    const owner = await tx.user.findUnique({ where: { id: task.ownerId } });
    if (owner?.status !== "ACTIVE") throw fail.blocked("The task owner is inactive. Reactivate them or hard-reassign before restoring.");
    if (task.projectId) {
      const p = await tx.project.findUnique({ where: { id: task.projectId } });
      if (p?.status === "ARCHIVED") throw fail.blocked(`Project ${p.name} is archived. Reopen it or unlink the task first.`);
    }
    const warnings: string[] = [];
    if (task.completedAt) {
      const m = monthKey(businessDateOf(task.completedAt));
      if (await tx.scorecardPeriod.findUnique({ where: { month: m } }))
        warnings.push(`Task completed in closed scorecard period ${m}. The frozen period is unchanged; post a correction if credit is due.`);
    }
    await tx.task.update({
      where: { id },
      data: { softDeleted: false, deletedAt: null, deletedById: null, deletionReason: null, version: { increment: 1 }, updatedById: actor.id },
    });
    await audit(tx, {
      recordId: id, eventType: "TASK_RESTORED", actor, reason: reason.trim(),
      previousValue: { softDeleted: true, deletedAt: task.deletedAt?.toISOString(), deletedBy: task.deletedById, deletionReason: task.deletionReason },
      newValue: { softDeleted: false, warnings },
    });
    await enqueue(tx, { eventType: "TASK_RESTORED", transitionId: `restore-${task.version}`, taskId: id, recipientIds: [task.ownerId], actorId: actor.id, subject: `Restored from Bin: ${task.name}`, payload: { taskId: id, reason } });
    return { task: toDTO(await tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude }), undefined, actor), warnings };
  });
}

export const hardDeleteSchema = z.object({ reason: z.string().nullish(), confirmId: z.string(), backupReference: z.string().nullish() });

// What a purge removes, shown in the confirmation before it happens.
export async function purgePreview(tx: Tx, id: string) {
  const [subtasks, transfers, extensions, waivers, escalations, cancellations, access, notifications, audit] = await Promise.all([
    tx.subtask.count({ where: { taskId: id } }),
    tx.transfer.count({ where: { taskId: id } }),
    tx.extensionRequest.count({ where: { taskId: id } }),
    tx.waiverRequest.count({ where: { taskId: id } }),
    tx.escalation.count({ where: { taskId: id } }),
    tx.cancellationRequest.count({ where: { taskId: id } }),
    tx.taskAccess.count({ where: { taskId: id } }),
    tx.notificationEvent.count({ where: { taskId: id } }) ,
    tx.auditEvent.count({ where: { recordId: { startsWith: id } } }),
  ]);
  return { removed: { subtasks, transfers, extensions, waivers, escalations, cancellations, accessGrants: access, emailEvents: notifications }, retained: { auditEvents: audit } };
}

async function purgeBlockers(tx: Tx, id: string) {
  const task = await tx.task.findUnique({ where: { id }, select: { completedAt: true } });
  const blockers: Record<string, string> = {};
  if (await tx.task.count({ where: { clonedFromId: id } })) blockers.recurringSuccessors = "Later recurring occurrences were cloned from this task.";
  if (task?.completedAt) {
    const m = monthKey(businessDateOf(task.completedAt));
    if (await tx.scorecardPeriod.findUnique({ where: { month: m } })) blockers.closedScorecard = `Counted in closed KPI period ${m}.`;
  }
  return blockers;
}

// Brief §12: permanent deletion, Admin-only, typed confirmation. The task row and its workflow
// records go; the append-only audit trail (including this purge) is kept.
export async function hardDelete(actor: Actor, id: string, body: unknown) {
  const r = await purge(actor, id, body);
  // The denial is committed to the audit log first, then reported (brief UI-025).
  if ("denied" in r) throw fail.forbidden("Only an Admin can permanently purge tasks.");
  return r;
}

async function purge(actor: Actor, id: string, body: unknown) {
  const b = hardDeleteSchema.parse(body);
  return runTx(async (tx) => {
    if (!can(actor, "HARD_DELETE")) {
      await audit(tx, { recordId: id, eventType: "TASK_PURGE_DENIED", actor, result: "REJECTED" });
      return { denied: true as const };
    }
    const errors: Record<string, string> = {};
    if (!b.reason?.trim()) errors.reason = "A reason is required.";
    if (b.confirmId.trim().toUpperCase() !== id.toUpperCase()) errors.confirmId = "Type the task ID exactly to confirm.";
    if (Object.keys(errors).length) throw fail.validation(errors);
    const task = await loadTask(tx, id, actor, { lock: true, allowDeleted: true });
    if (!task.softDeleted) throw fail.blocked("Move the task to the bin before purging it.");
    const blockers = await purgeBlockers(tx, id);
    if (Object.keys(blockers).length) throw fail.blocked(Object.values(blockers).join(" "), blockers);
    const preview = await purgePreview(tx, id);
    await audit(tx, {
      recordId: id, eventType: "TASK_HARD_DELETED", actor, reason: b.reason!.trim(),
      previousValue: { id: task.id, name: task.name, ownerId: task.ownerId, channel: task.channel.name, status: task.status, assignedDate: iso(task.assignedDate), deadline: iso(task.deadline) },
      newValue: { backupReference: b.backupReference?.trim() || null, removed: preview.removed },
    });
    await tx.escalationLevelChange.deleteMany({ where: { escalation: { taskId: id } } });
    await tx.escalation.deleteMany({ where: { taskId: id } });
    await tx.waiverRequest.deleteMany({ where: { taskId: id } });
    await tx.extensionRequest.deleteMany({ where: { taskId: id } });
    await tx.transfer.deleteMany({ where: { taskId: id } });
    await tx.cancellationRequest.deleteMany({ where: { taskId: id } });
    await tx.subtask.deleteMany({ where: { taskId: id } });
    await tx.notificationEvent.deleteMany({ where: { taskId: id } });
    await tx.inAppNotification.deleteMany({ where: { taskId: id } });
    await tx.task.update({ where: { id }, data: { pocId: null } });
    await tx.task.delete({ where: { id } });
    return { ok: true as const };
  });
}

export async function listBin(actor: Actor) {
  assertCan(actor, "VIEW_BIN");
  const rows = await prisma.task.findMany({ where: { softDeleted: true }, include: taskInclude, orderBy: { deletedAt: "desc" } });
  const users = await prisma.user.findMany({ select: { id: true, name: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const previews = await Promise.all(rows.map((r) => purgePreview(prisma as unknown as Tx, r.id)));
  return {
    canRestore: can(actor, "RESTORE"),
    canPurge: can(actor, "HARD_DELETE"),
    rows: rows.map((r, i) => ({ ...toDTO(r, undefined, actor), deletedByName: r.deletedById ? names[r.deletedById] ?? r.deletedById : null, purge: previews[i] })),
  };
}
