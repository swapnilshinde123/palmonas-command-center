import { z } from "zod";
import type { DepTier, Prisma, TaskStatus } from "@prisma/client";
import { tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { iso, tryParseISODate } from "@/lib/dates";
import { assertCan, isPrivileged, type Actor } from "./rbac";
import { audit, diff } from "./audit";
import { allocateSubtaskId } from "./ids";
import { enqueue } from "./notifications/enqueue";
import { DEP_TIERS, loadTask, validateUrl, grantAccess } from "./task-core";
import { TRANSITIONS } from "./tasks";
import { isActive } from "./sla";

export const subtaskCreateSchema = z.object({
  title: z.string().optional().default(""),
  description: z.string().nullish(),
  ownerId: z.string().nullish(),
  depType: z.string().nullish(),
  pendingFrom: z.string().nullish(),
  dueDate: z.string().nullish(),
  required: z.boolean().optional(),
});

async function validateOwner(tx: Tx, ownerId: string | null | undefined, errors: Record<string, string>) {
  if (!ownerId) return null;
  const u = await tx.user.findFirst({ where: { id: ownerId, status: "ACTIVE" } });
  if (!u) errors.ownerId = "Owner must be an active team member.";
  return u?.id ?? null;
}

export async function createSubtask(actor: Actor, taskId: string, body: unknown) {
  const b = subtaskCreateSchema.parse(body);
  return runTx(async (tx) => {
    const task = await loadTask(tx, taskId, actor, { lock: true });
    assertCan(actor, "MANAGE_SUBTASKS", task.ownerId === actor.id);
    if (!isActive(task.status)) throw fail.blocked("Subtasks can only be added to active tasks.");
    const errors: Record<string, string> = {};
    const title = b.title.trim();
    if (title.length < 2) errors.title = "Subtask title is required.";
    const ownerId = await validateOwner(tx, b.ownerId, errors);
    if (b.depType && !DEP_TIERS.includes(b.depType as DepTier)) errors.depType = "Invalid dependency type.";
    const due = b.dueDate ? tryParseISODate(b.dueDate) : null;
    if (b.dueDate && !due) errors.dueDate = "Enter a valid date.";
    if (Object.keys(errors).length) throw fail.validation(errors);

    const id = await allocateSubtaskId(tx, taskId);
    const sub = await tx.subtask.create({
      data: { id, taskId, title, description: b.description?.trim() ?? "", ownerId, depType: (b.depType || null) as DepTier | null, pendingFrom: b.pendingFrom?.trim() || null, dueDate: due, required: b.required ?? true, createdById: actor.id },
    });
    await tx.task.update({ where: { id: taskId }, data: { version: { increment: 1 }, updatedById: actor.id } });
    await audit(tx, { recordId: id, entityType: "SUBTASK", eventType: "SUBTASK_CREATED", actor, relatedEntityId: taskId, newValue: { title, ownerId, depType: sub.depType, dueDate: iso(due) } });
    await grantAccess(tx, taskId, ownerId && ownerId !== task.ownerId ? ownerId : null, "SUBTASK", actor.id);
    if (ownerId && ownerId !== actor.id)
      await enqueue(tx, { eventType: "SUBTASK_ASSIGNED", transitionId: `${id}:${ownerId}`, taskId, recipientIds: [ownerId], subject: `Subtask assigned: ${title}`, payload: { taskId, subtaskId: id, parent: task.name, by: actor.name } });
    return sub;
  });
}

export const subtaskUpdateSchema = z.object({
  expectedVersion: z.number().int(),
  reason: z.string().nullish(),
  patch: z.object({
    title: z.string().optional(), description: z.string().optional(), ownerId: z.string().nullable().optional(),
    depType: z.string().nullable().optional(), pendingFrom: z.string().nullable().optional(), dueDate: z.string().nullable().optional(),
    outputLink: z.string().nullable().optional(), required: z.boolean().optional(),
  }).strict(),
});

async function loadSub(tx: Tx, actor: Actor, id: string) {
  await tx.$executeRaw`SELECT 1 FROM "Subtask" WHERE "id" = ${id} FOR UPDATE`;
  const sub = await tx.subtask.findUnique({ where: { id } });
  if (!sub) throw fail.notFound("Subtask");
  const parent = await loadTask(tx, sub.taskId, actor);
  return { sub, parent, parentOwner: parent.ownerId === actor.id, subOwner: sub.ownerId === actor.id };
}

export async function updateSubtask(actor: Actor, id: string, body: unknown) {
  const { expectedVersion, patch, reason } = subtaskUpdateSchema.parse(body);
  return runTx(async (tx) => {
    const { sub, parent, parentOwner, subOwner } = await loadSub(tx, actor, id);
    const manager = isPrivileged(actor) || parentOwner;
    const ownerOnlyFields = ["outputLink", "pendingFrom"];
    const touched = Object.keys(patch);
    // Subtask owners get a narrow edit surface; they never gain parent-level edit rights (§37.2).
    if (!manager && !(subOwner && touched.every((k) => ownerOnlyFields.includes(k)))) throw fail.forbidden();
    if (sub.status === "COMPLETED" && touched.some((k) => k !== "outputLink")) throw fail.blocked("Reopen the subtask before editing it.");

    const errors: Record<string, string> = {};
    const data: Prisma.SubtaskUncheckedUpdateManyInput = {};
    if (patch.title !== undefined) { if (patch.title.trim().length < 2) errors.title = "Title is required."; else data.title = patch.title.trim(); }
    if (patch.description !== undefined) data.description = patch.description.trim();
    if (patch.ownerId !== undefined) {
      data.ownerId = await validateOwner(tx, patch.ownerId, errors);
      if (data.ownerId && data.ownerId !== parent.ownerId) await grantAccess(tx, parent.id, data.ownerId as string, "SUBTASK", actor.id);
    }
    if (patch.depType !== undefined) { if (patch.depType && !DEP_TIERS.includes(patch.depType as DepTier)) errors.depType = "Invalid dependency type."; else data.depType = (patch.depType || null) as DepTier | null; }
    if (patch.pendingFrom !== undefined) data.pendingFrom = patch.pendingFrom?.trim() || null;
    if (patch.dueDate !== undefined) { const d = patch.dueDate ? tryParseISODate(patch.dueDate) : null; if (patch.dueDate && !d) errors.dueDate = "Enter a valid date."; else data.dueDate = d; }
    if (patch.outputLink !== undefined) { const e = validateUrl(patch.outputLink); if (e) errors.outputLink = e; else data.outputLink = patch.outputLink?.trim() || null; }
    if (patch.required !== undefined) data.required = patch.required;
    if (Object.keys(errors).length) throw fail.validation(errors);

    const { prev, next, changed } = diff(sub as unknown as Record<string, unknown>, data as Record<string, unknown>);
    if (!changed.length) return sub;
    const r = await tx.subtask.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (r.count === 0) throw fail.stale(await tx.subtask.findUnique({ where: { id } }));
    await audit(tx, { recordId: id, entityType: "SUBTASK", eventType: "ownerId" in next ? "SUBTASK_REASSIGNED" : "SUBTASK_UPDATED", actor, previousValue: prev, newValue: next, reason, relatedEntityId: parent.id });
    if (next.ownerId && next.ownerId !== actor.id)
      await enqueue(tx, { eventType: "SUBTASK_ASSIGNED", transitionId: `${id}:${next.ownerId}:v${expectedVersion + 1}`, taskId: parent.id, recipientIds: [next.ownerId as string], subject: `Subtask assigned: ${sub.title}`, payload: { taskId: parent.id, subtaskId: id, by: actor.name } });
    return tx.subtask.findUniqueOrThrow({ where: { id } });
  });
}

export const subtaskStatusSchema = z.object({ to: z.enum(["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "DROPPED"]), expectedVersion: z.number().int(), reason: z.string().nullish() });

export async function changeSubtaskStatus(actor: Actor, id: string, body: unknown) {
  const { to, expectedVersion, reason } = subtaskStatusSchema.parse(body);
  return runTx(async (tx) => {
    const { sub, parent, parentOwner, subOwner } = await loadSub(tx, actor, id);
    if (!isPrivileged(actor) && !parentOwner && !subOwner) throw fail.forbidden();
    const from = sub.status as TaskStatus;
    if (from === to) return sub;
    if (!TRANSITIONS[from].includes(to)) throw fail.transition(from, to);
    const r = reason?.trim();
    if ((to === "DROPPED" || from === "COMPLETED" || from === "DROPPED") && !r) throw fail.validation({ reason: "A reason is required." });
    if (from === "COMPLETED" && to !== "IN_PROGRESS") throw fail.transition(from, to);
    if (to === "DROPPED" && !isPrivileged(actor) && !parentOwner) throw fail.forbidden("Only the parent owner or Admin/Leadership can cancel a subtask.");

    const data: Prisma.SubtaskUncheckedUpdateManyInput = { status: to };
    if (to === "COMPLETED") { data.completedAt = new Date(); data.completedById = actor.id; }
    if (from === "COMPLETED") { data.completedAt = null; data.completedById = null; }
    if (to === "DROPPED") data.droppedReason = r;
    const res = await tx.subtask.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) throw fail.stale(await tx.subtask.findUnique({ where: { id } }));
    await tx.task.update({ where: { id: parent.id }, data: { version: { increment: 1 } } });
    await audit(tx, { recordId: id, entityType: "SUBTASK", eventType: to === "COMPLETED" ? "SUBTASK_COMPLETED" : to === "DROPPED" ? "SUBTASK_DROPPED" : "SUBTASK_STATUS_CHANGED", actor, previousValue: from, newValue: to, reason: r, relatedEntityId: parent.id });

    if (to === "COMPLETED") {
      const open = await tx.subtask.count({ where: { taskId: parent.id, required: true, status: { notIn: ["COMPLETED", "DROPPED"] } } });
      if (open === 0) await audit(tx, { recordId: parent.id, eventType: "PARENT_READY_FOR_COMPLETION", actor: null, relatedEntityId: id });
    }
    return tx.subtask.findUniqueOrThrow({ where: { id } });
  });
}
