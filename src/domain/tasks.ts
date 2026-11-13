import { z } from "zod";
import type { Prisma, TaskStatus, DepTier } from "@prisma/client";
import { prisma, tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { iso, todayBiz, tryParseISODate } from "@/lib/dates";
import { getConfig } from "@/lib/config";
import { assertCan, can, decide, isPrivileged, type Actor } from "./rbac";
import { addDays } from "@/lib/dates";
import { audit, diff } from "./audit";
import { allocateTaskId } from "./ids";
import { withIdempotency } from "./idempotency";
import { enqueue, governanceRecipients } from "./notifications/enqueue";
import {
  DEP_TIERS, grantAccess, isExcludedName, isOwner, legacyMetadataView, loadTask, resolveSlaPolicy, taskInclude, toDTO,
  validateUrl, versionedUpdate, visibleWhere, type TaskDTO,
} from "./task-core";
import { resolvePending, type PendingInput } from "./poc";
import { createTransferInTx } from "./governance";
import { onOccurrenceTerminal } from "./recurrence";
import { ACTIVE_STATUSES } from "./sla";

// ---------- Create ----------

export const createTaskSchema = z.object({
  name: z.string().optional().default(""),
  channelId: z.string().optional().default(""),
  ownerId: z.string().optional().default(""),
  priority: z.union([z.number(), z.string()]).optional(),
  deadline: z.string().optional().default(""),
  workstreamId: z.string().nullish(),
  projectId: z.string().nullish(),
  description: z.string().nullish(),
  outputLink: z.string().nullish(),
  // Pending From (brief §6): pocType + (pocId of a registry POC | pendingFrom free-text custom POC name).
  pocType: z.string().nullish(),
  pocId: z.string().nullish(),
  pendingFrom: z.string().nullish(),
  followupDate: z.string().nullish(),
  p0Justification: z.string().nullish(),
  transferReason: z.string().nullish(),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

interface ValidCreate {
  name: string;
  channelId: string;
  channelName: string;
  ownerId: string;
  priority: number;
  deadline: Date;
  pocType: DepTier | null;
  pocId: string | null;
  customPoc: boolean;
  workstreamId: string | null;
  projectId: string | null;
  description: string;
  outputLink: string | null;
  pendingFrom: string | null;
  followupDate: Date | null;
}

function parsePriority(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/^p/i, ""));
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : NaN;
}

// Server-side re-validation (spec §9): trims, never coerces an invalid value into a different valid one.
async function validateCreate(tx: Tx, raw: z.infer<typeof createTaskSchema>, assignedDate: Date): Promise<ValidCreate> {
  const errors: Record<string, string> = {};
  const name = raw.name.trim();
  if (!name) errors.name = "Task name is required.";
  else if (name.length < 3) errors.name = "Use at least 3 characters.";
  else if (name.length > 300) errors.name = "Keep the task name under 300 characters.";

  const channel = raw.channelId ? await tx.channel.findFirst({ where: { id: raw.channelId, active: true } }) : null;
  if (!raw.channelId) errors.channelId = "Channel is required.";
  else if (!channel) errors.channelId = "Pick a channel from the list.";

  const owner = raw.ownerId ? await tx.user.findFirst({ where: { id: raw.ownerId, status: "ACTIVE" } }) : null;
  if (!raw.ownerId) errors.ownerId = "Owner is required.";
  else if (!owner) errors.ownerId = "Owner must be an active team member.";

  const priority = parsePriority(raw.priority);
  if (priority === null) errors.priority = "Priority is required.";
  else if (Number.isNaN(priority)) errors.priority = "Priority must be P0–P10.";

  const deadline = tryParseISODate(raw.deadline);
  const dl = await getConfig("deadlines", tx);
  if (!raw.deadline) errors.deadline = "Deadline is required.";
  else if (!deadline) errors.deadline = "Enter a valid date.";
  else if (!dl.allowBeforeAssigned && deadline < assignedDate) errors.deadline = "Deadline can't be before the assigned date.";
  else if (!dl.allowSameDay && deadline.getTime() === assignedDate.getTime()) errors.deadline = "Same-day deadlines are not allowed.";

  const pending = await resolvePending(tx, { pocType: raw.pocType, pocId: raw.pocId, pendingFrom: raw.pendingFrom }, errors);

  if (raw.workstreamId && !(await tx.workstream.findFirst({ where: { id: raw.workstreamId, active: true } }))) errors.workstreamId = "Pick a workstream from the list.";
  if (raw.projectId) {
    const p = await tx.project.findUnique({ where: { id: raw.projectId } });
    if (!p) errors.projectId = "Project not found.";
    else if (p.status === "ARCHIVED" || p.status === "COMPLETED") errors.projectId = "This project is closed to new tasks.";
  }

  const urlErr = validateUrl(raw.outputLink);
  if (urlErr) errors.outputLink = urlErr;

  const maxLen = (await getConfig("descriptionMaxLength", tx)) as number;
  const description = (raw.description ?? "").trim();
  if (description.length > maxLen) errors.description = `Keep the description under ${maxLen} characters.`;

  let followupDate: Date | null = null;
  if (raw.followupDate) {
    followupDate = tryParseISODate(raw.followupDate);
    if (!followupDate) errors.followupDate = "Enter a valid date.";
  }

  if (Object.keys(errors).length) throw fail.validation(errors);
  return {
    name, channelId: channel!.id, channelName: channel!.name, ownerId: owner!.id, priority: priority!, deadline: deadline!,
    pocType: pending.pocType, pocId: pending.pocId, customPoc: pending.custom, workstreamId: raw.workstreamId || null, projectId: raw.projectId || null, description,
    outputLink: raw.outputLink?.trim() || null, pendingFrom: pending.pendingFrom, followupDate,
  };
}

export interface InsertOpts {
  seriesId?: string;
  occurrenceNumber?: number;
  scheduledDate?: Date;
  clonedFromId?: string | null;
  assignedDate?: Date;
  requestId?: string | null;
  idNamespace?: string;
}

// Shared insert path for UI creates and recurrence spawns.
export async function insertTask(tx: Tx, actor: Actor | null, v: ValidCreate, opts: InsertOpts = {}) {
  const assignedDate = opts.assignedDate ?? todayBiz();
  const id = await allocateTaskId(tx, opts.idNamespace ?? actor?.code ?? "SYS");
  const slaPolicyId = await resolveSlaPolicy(tx, v.priority, v.channelName);
  const created = await tx.task.create({
    data: {
      id, name: v.name, description: v.description, channelId: v.channelId, ownerId: v.ownerId, priority: v.priority,
      assignedDate, deadline: v.deadline, originalDeadline: v.deadline, pocType: v.pocType, pocId: v.pocId,
      pendingSince: v.pocType ? new Date() : null,
      workstreamId: v.workstreamId, projectId: v.projectId, outputLink: v.outputLink, pendingFrom: v.pendingFrom,
      followupDate: v.followupDate, slaPolicyId, excludedFromMetrics: await isExcludedName(tx, v.name),
      seriesId: opts.seriesId, occurrenceNumber: opts.occurrenceNumber, scheduledDate: opts.scheduledDate,
      clonedFromId: opts.clonedFromId ?? null, createdById: actor?.id ?? "system", updatedById: actor?.id ?? "system",
    },
    include: taskInclude,
  });
  // A custom POC stays scoped to this task until L1 promotes it (brief §6).
  if (v.customPoc && v.pocType && v.pendingFrom) {
    const poc = await tx.poc.create({ data: { name: v.pendingFrom, type: v.pocType, isRegistry: false, taskId: id, createdById: actor?.id ?? null } });
    await tx.task.update({ where: { id }, data: { pocId: poc.id } });
  }
  if (actor && actor.id !== v.ownerId) await grantAccess(tx, id, actor.id, "CREATOR", actor.id);
  await audit(tx, {
    recordId: id, eventType: "TASK_CREATED", actor, requestId: opts.requestId,
    newValue: { ...v, deadline: iso(v.deadline), followupDate: iso(v.followupDate), assignedDate: iso(assignedDate), slaPolicyId, seriesId: opts.seriesId ?? null },
    relatedEntityId: opts.seriesId ?? v.projectId,
  });
  return created;
}

export async function createTask(actor: Actor, input: CreateTaskInput, idempotencyKey?: string | null) {
  const raw = createTaskSchema.parse(input);
  return withIdempotency(actor, idempotencyKey, "task.create", async (tx) => {
    assertCan(actor, "CREATE_TASK", true);
    const assignedDate = todayBiz();
    const v = await validateCreate(tx, raw, assignedDate);

    if (v.priority === 0 && !can(actor, "SET_P0_DIRECT") && !raw.p0Justification?.trim())
      throw fail.validation({ p0Justification: "P0 needs a written justification." });

    // Members can't silently assign to a peer (§26.1): they own it until the peer accepts the transfer.
    const peer = v.ownerId !== actor.id && !can(actor, "ASSIGN_ANY_OWNER") ? v.ownerId : null;
    if (peer) v.ownerId = actor.id;

    const task = await insertTask(tx, actor, v, { requestId: idempotencyKey });
    if (v.priority === 0 && raw.p0Justification)
      await audit(tx, { recordId: task.id, eventType: "P0_JUSTIFIED", actor, reason: raw.p0Justification.trim() });

    if (peer) {
      await createTransferInTx(tx, actor, task, peer, raw.transferReason?.trim() || "Created for peer collaboration");
    } else if (v.ownerId !== actor.id) {
      await enqueue(tx, {
        eventType: "TASK_ASSIGNED", transitionId: "created", taskId: task.id, recipientIds: [v.ownerId], actorId: actor.id,
        subject: `${actor.name} assigned you: ${task.name}`, payload: { taskId: task.id, task: task.name, by: actor.name, priority: `P${task.priority}`, deadline: iso(task.deadline) },
      });
    }
    const fresh = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    return { task: toDTO(fresh, undefined, actor), peerTransferPending: !!peer };
  });
}

// ---------- Update ----------

export const updateTaskSchema = z.object({
  expectedVersion: z.number().int(),
  reason: z.string().nullish(),
  patch: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    channelId: z.string().optional(),
    workstreamId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    priority: z.union([z.number(), z.string()]).optional(),
    deadline: z.string().optional(),
    assignedDate: z.string().optional(),
    remarks: z.string().nullable().optional(),
    pocType: z.string().nullable().optional(),
    pocId: z.string().nullable().optional(),
    pendingFrom: z.string().nullable().optional(),
    followupDate: z.string().nullable().optional(),
    outputLink: z.string().nullable().optional(),
    revenueCritical: z.boolean().optional(),
  }).strict(),
});

const SYSTEM_FIELDS = ["id", "ownerId", "status", "flagged", "starred", "softDeleted", "originalDeadline", "escalationLevel", "completedAt", "extensionsCount", "waivedExtensionsCount", "softDeleted", "escalationRequired", "version", "createdAt", "createdById", "slaPolicyId"];

export async function updateTask(actor: Actor, id: string, body: unknown) {
  // Formula/system fields are rejected outright rather than silently ignored (QA-011).
  if (body && typeof body === "object" && "patch" in body && body.patch && typeof body.patch === "object") {
    const sys = Object.keys(body.patch).filter((k) => SYSTEM_FIELDS.includes(k) || ["agingDays", "tatDays", "timeliness"].includes(k));
    if (sys.length) throw fail.validation(Object.fromEntries(sys.map((k) => [k, "This field is managed by the system."])));
  }
  const { expectedVersion, patch, reason } = updateTaskSchema.parse(body);
  return runTx(async (tx) => {
    const task = await loadTask(tx, id, actor, { lock: true });
    const own = isOwner(task, actor);
    const errors: Record<string, string> = {};
    const data: Prisma.TaskUncheckedUpdateManyInput = {};
    const events: { type: string; reason?: string | null }[] = [];

    const detailKeys = ["name", "description", "channelId", "workstreamId", "projectId", "remarks", "pocType", "pocId", "pendingFrom", "followupDate", "outputLink", "revenueCritical"] as const;
    if (detailKeys.some((k) => patch[k] !== undefined)) assertCan(actor, "EDIT_TASK_DETAILS", own);

    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (n.length < 3) errors.name = "Use at least 3 characters.";
      else { data.name = n; data.excludedFromMetrics = await isExcludedName(tx, n); }
    }
    if (patch.description !== undefined) data.description = patch.description.trim();
    if (patch.channelId !== undefined) {
      if (!(await tx.channel.findFirst({ where: { id: patch.channelId, active: true } }))) errors.channelId = "Pick a channel from the list.";
      else data.channelId = patch.channelId;
    }
    if (patch.workstreamId !== undefined) {
      if (patch.workstreamId && !(await tx.workstream.findFirst({ where: { id: patch.workstreamId, active: true } }))) errors.workstreamId = "Pick a workstream from the list.";
      else data.workstreamId = patch.workstreamId || null;
    }
    if (patch.projectId !== undefined) {
      if (patch.projectId) {
        const p = await tx.project.findUnique({ where: { id: patch.projectId } });
        if (!p) errors.projectId = "Project not found.";
        else if (p.status === "ARCHIVED" || p.status === "COMPLETED") errors.projectId = "This project is closed to new tasks.";
        else data.projectId = p.id;
      } else data.projectId = null;
    }
    if (patch.remarks !== undefined) data.remarks = patch.remarks?.trim() || null;
    let customPoc: { name: string; type: DepTier } | null = null;
    if (patch.pocType !== undefined || patch.pendingFrom !== undefined || patch.pocId !== undefined) {
      // POC Type and POC Name are validated together (brief §6); omitted parts fall back to current values.
      const input: PendingInput = {
        pocType: patch.pocType !== undefined ? patch.pocType : task.pocType,
        pocId: patch.pocId !== undefined ? patch.pocId : patch.pendingFrom !== undefined ? null : task.pocId,
        pendingFrom: patch.pendingFrom !== undefined ? patch.pendingFrom : task.pendingFrom,
      };
      const p = await resolvePending(tx, input, errors, id);
      data.pocType = p.pocType; data.pendingFrom = p.pendingFrom; data.pocId = p.pocId;
      if (p.custom && p.pocType && p.pendingFrom) customPoc = { name: p.pendingFrom, type: p.pocType };
      if (!task.pocType && p.pocType) data.pendingSince = new Date();
      if (!p.pocType) data.pendingSince = null;
    }
    if (patch.followupDate !== undefined) {
      const d = patch.followupDate ? tryParseISODate(patch.followupDate) : null;
      if (patch.followupDate && !d) errors.followupDate = "Enter a valid date.";
      else data.followupDate = d;
    }
    if (patch.outputLink !== undefined) {
      const e = validateUrl(patch.outputLink);
      if (e) errors.outputLink = e;
      else data.outputLink = patch.outputLink?.trim() || null;
    }
    if (patch.revenueCritical !== undefined) {
      if (!isPrivileged(actor)) errors.revenueCritical = "Only Admin or Leadership can mark revenue-critical.";
      else data.revenueCritical = patch.revenueCritical;
    }

    if (patch.priority !== undefined) {
      assertCan(actor, "CHANGE_PRIORITY", own);
      const p = parsePriority(patch.priority);
      if (p === null || Number.isNaN(p)) errors.priority = "Priority must be P0–P10.";
      else {
        if (p === 0 && task.priority !== 0 && decide(actor, "SET_P0_DIRECT") !== "ALLOW") {
          if (!reason?.trim()) errors.priority = "P0 needs a written justification.";
          else events.push({ type: "P0_JUSTIFIED", reason });
        }
        data.priority = p;
      }
    }

    if (patch.deadline !== undefined) {
      // Brief §8: nobody extends by editing the deadline. Only an Admin may record an audited
      // correction (e.g. a typo at creation); everyone else uses an Extension Request.
      if (!can(actor, "CHANGE_DEADLINE_DIRECT")) throw fail.forbidden("Deadlines can't be edited directly. Submit an extension request instead.");
      const d = tryParseISODate(patch.deadline);
      if (!d) errors.deadline = "Enter a valid date.";
      else if (d < task.assignedDate) errors.deadline = "Deadline can't be before the assigned date.";
      else if (!reason?.trim()) errors.deadline = "A reason is required to correct the deadline.";
      else { data.deadline = d; events.push({ type: "DEADLINE_CORRECTED", reason }); }
    }
    if (patch.assignedDate !== undefined) {
      if (actor.role !== "ADMIN") throw fail.forbidden("Assigned date can only be corrected by an administrator.");
      const d = tryParseISODate(patch.assignedDate);
      if (!d) errors.assignedDate = "Enter a valid date.";
      else if (!reason?.trim()) errors.assignedDate = "A reason is required.";
      else { data.assignedDate = d; events.push({ type: "ADMIN_OVERRIDE_ASSIGNED_DATE", reason }); }
    }

    if (Object.keys(errors).length) throw fail.validation(errors);
    const { prev, next, changed } = diff(task as unknown as Record<string, unknown>, data as Record<string, unknown>);
    if (changed.length === 0) return toDTO(task);

    await versionedUpdate(tx, id, expectedVersion, actor, data);
    if (customPoc) {
      const poc = await tx.poc.create({ data: { name: customPoc.name, type: customPoc.type, isRegistry: false, taskId: id, createdById: actor.id } });
      await tx.task.update({ where: { id }, data: { pocId: poc.id } });
    }
    await audit(tx, { recordId: id, eventType: "TASK_UPDATED", actor, previousValue: prev, newValue: next, reason });
    const n = (type: Parameters<typeof enqueue>[1]["eventType"], subject: string, payload: Record<string, unknown>, recipients: string[]) =>
      enqueue(tx, { eventType: type, transitionId: `v${expectedVersion + 1}`, taskId: id, recipientIds: recipients, actorId: actor.id, subject, payload: { taskId: id, task: task.name, by: actor.name, ...payload } });
    if ("priority" in next) {
      await audit(tx, { recordId: id, eventType: "PRIORITY_CHANGED", actor, previousValue: prev.priority, newValue: next.priority, reason });
      await n("PRIORITY_CHANGED", `Priority P${prev.priority} → P${next.priority}: ${task.name}`, { before: `P${prev.priority}`, after: `P${next.priority}`, reason }, [task.ownerId, ...(await governanceRecipients(tx))]);
    }
    if ("deadline" in next) {
      await audit(tx, { recordId: id, eventType: "DEADLINE_CHANGED", actor, previousValue: prev.deadline, newValue: next.deadline, reason });
      await n("DEADLINE_CHANGED", `Deadline corrected to ${next.deadline}: ${task.name}`, { before: prev.deadline, after: next.deadline, reason }, [task.ownerId]);
    }
    if ("pocType" in next || "pendingFrom" in next) {
      await audit(tx, { recordId: id, eventType: next.pocType === null ? "POC_CLEARED" : "POC_CHANGED", actor, previousValue: { pocType: prev.pocType ?? task.pocType, pendingFrom: prev.pendingFrom ?? task.pendingFrom }, newValue: { pocType: data.pocType, pendingFrom: data.pendingFrom } });
      await n("POC_CHANGED", `Pending From updated: ${task.name}`, { pocType: data.pocType, pendingFrom: data.pendingFrom }, [task.ownerId]);
    }
    if ("followupDate" in next) await n("POC_CHANGED", `Follow-up date set to ${next.followupDate ?? "none"}: ${task.name}`, { followupDate: next.followupDate }, [task.ownerId]);
    for (const e of events) await audit(tx, { recordId: id, eventType: e.type, actor, reason: e.reason });
    return toDTO(await tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude }), undefined, actor);
  });
}

// ---------- Status lifecycle ----------

export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  NOT_STARTED: ["IN_PROGRESS", "ON_HOLD", "COMPLETED", "DROPPED"],
  IN_PROGRESS: ["ON_HOLD", "COMPLETED", "DROPPED"],
  ON_HOLD: ["IN_PROGRESS", "COMPLETED", "DROPPED"],
  COMPLETED: ["IN_PROGRESS"],
  DROPPED: ["NOT_STARTED", "IN_PROGRESS"],
};

export const statusSchema = z.object({
  to: z.enum(["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "DROPPED"]),
  expectedVersion: z.number().int(),
  reason: z.string().nullish(),
  overrideIncompleteSubtasks: z.boolean().optional(),
});

export async function changeStatusInTx(tx: Tx, actor: Actor, id: string, body: z.infer<typeof statusSchema>, opts: { viaCancellation?: boolean } = {}) {
  const { to, expectedVersion, reason, overrideIncompleteSubtasks } = body;
  const task = await loadTask(tx, id, actor, { lock: true });
  const from = task.status;
  if (from === to) return toDTO(task);
  if (!TRANSITIONS[from].includes(to)) throw fail.transition(from, to);

  const own = isOwner(task, actor);
  const r = reason?.trim();
  let eventType = "STATUS_CHANGED";
  if (to === "DROPPED") {
    if (!opts.viaCancellation) assertCan(actor, "DROP_TASK");
    if (!r) throw fail.validation({ reason: "A reason is required to drop a task." });
    eventType = "TASK_DROPPED";
  } else if (from === "COMPLETED") {
    assertCan(actor, "REOPEN_COMPLETED", own);
    if (!r) throw fail.validation({ reason: "A reason is required to reopen a task." });
    eventType = "TASK_REOPENED";
  } else if (from === "DROPPED") {
    assertCan(actor, "REOPEN_DROPPED");
    if (!r) throw fail.validation({ reason: "A reason is required to reopen a task." });
    eventType = "TASK_REOPENED";
  } else {
    assertCan(actor, "CHANGE_STATUS", own);
  }

  const data: Prisma.TaskUncheckedUpdateManyInput = { status: to };
  if (to === "IN_PROGRESS" && !task.startedAt) data.startedAt = new Date();
  if (to === "COMPLETED") {
    eventType = "TASK_COMPLETED";
    const cfg = await getConfig("subtasks", tx);
    const open = task.subtasks.filter((s) => s.required && s.status !== "COMPLETED" && s.status !== "DROPPED");
    if (cfg.requireCompleteForParent && open.length) {
      if (!overrideIncompleteSubtasks) throw fail.blocked(`${open.length} required subtask(s) are still open.`, { openSubtasks: open.map((s) => s.id) });
      if (!isPrivileged(actor)) throw fail.forbidden("Only Admin or Leadership can complete a task with open subtasks.");
      if (!r) throw fail.validation({ reason: "A reason is required to override open subtasks." });
      await audit(tx, { recordId: id, eventType: "ADMIN_OVERRIDE_SUBTASKS", actor, reason: r, newValue: { openSubtasks: open.map((s) => s.id) } });
    }
    data.completedAt = new Date();
    data.completedById = actor.id;
  }
  if (from === "COMPLETED") { data.completedAt = null; data.completedById = null; }
  if (to === "DROPPED") data.droppedReason = r;
  if (from === "DROPPED") data.droppedReason = null;

  await versionedUpdate(tx, id, expectedVersion, actor, data);
  await audit(tx, {
    recordId: id, eventType, actor, reason: r,
    previousValue: { status: from, completedAt: task.completedAt?.toISOString() ?? null },
    newValue: { status: to, completedAt: (data.completedAt as Date | null | undefined)?.toISOString?.() ?? null },
  });

  const updated = await tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude });
  if (to === "COMPLETED" || to === "DROPPED") await onOccurrenceTerminal(tx, updated, actor);
  await enqueue(tx, {
    eventType: "STATUS_CHANGED", transitionId: `v${expectedVersion + 1}`, taskId: id, recipientIds: [task.ownerId], actorId: actor.id,
    subject: `${STATUS_TEXT[to]}: ${task.name}`, payload: { taskId: id, task: task.name, by: actor.name, from, to, reason: r },
  });
  return toDTO(updated, undefined, actor);
}

const STATUS_TEXT: Record<TaskStatus, string> = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", ON_HOLD: "On hold", COMPLETED: "Completed", DROPPED: "Dropped" };

export async function changeStatus(actor: Actor, id: string, body: unknown) {
  const parsed = statusSchema.parse(body);
  return runTx((tx) => changeStatusInTx(tx, actor, id, parsed));
}

// ---------- Read ----------

export const listSchema = z.object({
  q: z.string().optional(),
  channelId: z.string().optional(),
  ownerId: z.string().optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
  timeliness: z.string().optional(),
  projectId: z.string().optional(),
  pocType: z.string().optional(),
  escalated: z.string().optional(),
  flagged: z.string().optional(),
  starred: z.string().optional(),
  due: z.enum(["soon", "overdue"]).optional(),
  // view: mine (default for everyone, brief §2) | team (Admin/Leadership only) | shared (contextual access, not owned)
  view: z.enum(["mine", "team", "shared", "all"]).optional(),
  scope: z.enum(["active", "all", "completed", "dropped"]).optional(),
  seriesId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export async function listTasks(actor: Actor, raw: unknown): Promise<TaskDTO[]> {
  const f = listSchema.parse(raw ?? {});
  const and: Prisma.TaskWhereInput[] = [visibleWhere(actor), { softDeleted: false }];
  const view = f.view ?? "mine";
  if (view === "team" && !isPrivileged(actor)) throw fail.forbidden("Only Admin and Leadership can open the team view.");
  if (view === "mine") and.push({ ownerId: actor.id });
  if (view === "shared") and.push({ ownerId: { not: actor.id } });
  if (f.ownerId && f.ownerId !== actor.id && !isPrivileged(actor) && view !== "shared" && view !== "all") throw fail.forbidden("You can only filter by other owners in the team view.");
  if (f.starred === "true") {
    if (!isPrivileged(actor)) throw fail.forbidden("Starred tasks are visible to Admin and Leadership only.");
    and.push({ starred: true });
  }
  if (f.flagged === "true") and.push({ flagged: true });
  if (f.due) {
    const today = todayBiz();
    if (f.due === "overdue") and.push({ status: { in: ACTIVE_STATUSES }, deadline: { lt: today } });
    else {
      const cfg = await getConfig("dueSoon");
      and.push({ status: { in: ACTIVE_STATUSES }, OR: [{ deadline: { gte: today, lte: addDays(today, cfg.deadlineDays) } }, { followupDate: { lte: addDays(today, cfg.followupDays) } }] });
    }
  }
  if (f.q) and.push({ OR: [{ name: { contains: f.q, mode: "insensitive" } }, { id: { contains: f.q, mode: "insensitive" } }, { pendingFrom: { contains: f.q, mode: "insensitive" } }] });
  if (f.channelId) and.push({ channelId: f.channelId });
  if (f.ownerId) and.push({ ownerId: f.ownerId });
  if (f.priority) and.push({ priority: Number(f.priority.replace(/^p/i, "")) });
  if (f.projectId) and.push({ projectId: f.projectId });
  if (f.seriesId) and.push({ seriesId: f.seriesId });
  if (f.pocType === "any") and.push({ pocType: { not: null } });
  else if (f.pocType) and.push({ pocType: f.pocType as DepTier });
  if (f.escalated === "true") and.push({ escalationRequired: true });
  if (f.status) and.push({ status: f.status as TaskStatus });
  const scope = f.scope ?? "active";
  if (!f.status) {
    if (scope === "active") and.push({ status: { in: ACTIVE_STATUSES } });
    if (scope === "completed") and.push({ status: "COMPLETED" });
    if (scope === "dropped") and.push({ status: "DROPPED" });
  }
  const rows = await prisma.task.findMany({
    where: { AND: and }, include: taskInclude,
    orderBy: [{ priority: "asc" }, { deadline: "asc" }], take: f.limit ?? 500,
  });
  const today = todayBiz();
  let out = rows.map((r) => toDTO(r, today, actor));
  if (f.timeliness) out = out.filter((t) => t.timeliness === f.timeliness);
  return out;
}

export async function getTaskDetail(actor: Actor, id: string) {
  const task = await prisma.task.findFirst({ where: { id, ...visibleWhere(actor) }, include: taskInclude });
  if (!task) throw fail.notFound("Task");
  if (task.softDeleted && !can(actor, "VIEW_BIN")) throw fail.notFound("Task");
  const [subtasks, transfers, extensions, waivers, escalations, cancellations, users, access] = await Promise.all([
    prisma.subtask.findMany({ where: { taskId: id }, orderBy: { createdAt: "asc" }, include: { owner: { select: { id: true, name: true } } } }),
    prisma.transfer.findMany({ where: { taskId: id }, orderBy: { requestedAt: "desc" } }),
    prisma.extensionRequest.findMany({ where: { taskId: id }, orderBy: { requestedAt: "desc" } }),
    prisma.waiverRequest.findMany({ where: { taskId: id }, orderBy: { requestedAt: "desc" } }),
    prisma.escalation.findMany({ where: { taskId: id }, orderBy: { triggeredAt: "desc" }, include: { levelChanges: { orderBy: { at: "asc" } } } }),
    prisma.cancellationRequest.findMany({ where: { taskId: id }, orderBy: { requestedAt: "desc" } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.taskAccess.findMany({ where: { taskId: id, revokedAt: null }, include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } }),
  ]);
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const own = isOwner(task, actor);
  const priv = isPrivileged(actor);
  const history = can(actor, "VIEW_AUDIT", true)
    ? await prisma.auditEvent.findMany({ where: { OR: [{ recordId: id }, { recordId: { startsWith: `${id}-S` } }] }, orderBy: { seq: "asc" }, take: 500 })
    : [];
  const activeEsc = escalations.find((e) => e.active);
  const isEscOwner = !!actor.escalationLevel || priv;
  return {
    task: toDTO(task, undefined, actor),
    names,
    permissions: {
      edit: can(actor, "EDIT_TASK_DETAILS", own),
      status: can(actor, "CHANGE_STATUS", own),
      drop: can(actor, "DROP_TASK"),
      reopenCompleted: can(actor, "REOPEN_COMPLETED", own),
      reopenDropped: can(actor, "REOPEN_DROPPED"),
      transfer: can(actor, "INITIATE_TRANSFER", own),
      transferOverride: can(actor, "TRANSFER_OVERRIDE"),
      requestExtension: can(actor, "REQUEST_EXTENSION", own),
      requestWaiver: can(actor, "REQUEST_WAIVER", own),
      decideExtension: can(actor, "DECIDE_EXTENSION"),
      decideWaiver: can(actor, "DECIDE_WAIVER"),
      escalate: !activeEsc && can(actor, "TRIGGER_ESCALATION", own || task.createdById === actor.id),
      reassignEscalation: !!activeEsc && isEscOwner,
      resolveEscalation: !!activeEsc && isEscOwner,
      flag: own || priv,
      star: priv,
      softDelete: can(actor, "SOFT_DELETE"),
      requestCancellation: can(actor, "REQUEST_CANCELLATION", own),
      restore: can(actor, "RESTORE"),
      purge: can(actor, "HARD_DELETE"),
      deadlineCorrection: can(actor, "CHANGE_DEADLINE_DIRECT"),
      manageSubtasks: can(actor, "MANAGE_SUBTASKS", own),
      priorityP0Direct: can(actor, "SET_P0_DIRECT"),
      revenueCritical: priv,
      manageAccess: priv || own,
    },
    access: access.map((a) => ({ id: a.id, userId: a.userId, name: a.user.name, reason: a.reason, createdAt: a.createdAt.toISOString() })),
    subtasks: subtasks.map((s) => ({ ...s, dueDate: iso(s.dueDate) })),
    transfers: transfers.map((t) => ({ ...t, deadlineAtRequest: iso(t.deadlineAtRequest) })),
    extensions: extensions.map((e) => ({ ...e, previousDeadline: iso(e.previousDeadline), requestedDeadline: iso(e.requestedDeadline), finalDeadline: iso(e.finalDeadline) })),
    waivers,
    escalations,
    cancellations,
    history: history.map((h) => ({ ...h, seq: Number(h.seq) })),
    rawMetadata: can(actor, "VIEW_RAW_METADATA") ? legacyMetadataView(task, task.escalations[0]?.level ?? null) : undefined,
  };
}

// ---------- Flag & star (brief §4) ----------

// Flag is a personal "needs attention" marker, distinct from escalation. Owner or Admin/Leadership.
export async function setFlag(actor: Actor, id: string, body: unknown) {
  const { flagged } = z.object({ flagged: z.boolean() }).parse(body);
  return runTx(async (tx) => {
    const task = await loadTask(tx, id, actor, { lock: true });
    if (!isOwner(task, actor) && !isPrivileged(actor)) throw fail.forbidden("Only the task owner, Admin or Leadership can flag a task.");
    if (task.flagged === flagged) return toDTO(task, undefined, actor);
    await tx.task.update({ where: { id }, data: { flagged, flaggedById: flagged ? actor.id : null, version: { increment: 1 }, updatedById: actor.id } });
    await audit(tx, { recordId: id, eventType: flagged ? "TASK_FLAGGED" : "TASK_UNFLAGGED", actor });
    return toDTO(await tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude }), undefined, actor);
  });
}

// Star is Admin/Leadership only and never widens anyone's access.
export async function setStar(actor: Actor, id: string, body: unknown) {
  const { starred } = z.object({ starred: z.boolean() }).parse(body);
  if (!isPrivileged(actor)) throw fail.forbidden("Only Admin and Leadership can star tasks.");
  return runTx(async (tx) => {
    const task = await loadTask(tx, id, actor, { lock: true });
    if (task.starred === starred) return toDTO(task, undefined, actor);
    await tx.task.update({ where: { id }, data: { starred, starredById: starred ? actor.id : null, starredAt: starred ? new Date() : null } });
    await audit(tx, { recordId: id, eventType: starred ? "TASK_STARRED" : "TASK_UNSTARRED", actor });
    await enqueue(tx, {
      eventType: "TASK_STARRED", transitionId: `${starred ? "star" : "unstar"}:${Date.now()}`, taskId: id, actorId: actor.id,
      recipientIds: (await governanceRecipients(tx)), subject: `${actor.name} ${starred ? "starred" : "unstarred"}: ${task.name}`, payload: { taskId: id },
    });
    return toDTO(await tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude }), undefined, actor);
  });
}

// ---------- Contextual access management (brief §2) ----------

export async function addCollaborator(actor: Actor, id: string, body: unknown) {
  const { userId } = z.object({ userId: z.string() }).parse(body);
  return runTx(async (tx) => {
    const task = await loadTask(tx, id, actor);
    if (!isOwner(task, actor) && !isPrivileged(actor)) throw fail.forbidden("Only the owner, Admin or Leadership can share a task.");
    const u = await tx.user.findFirst({ where: { id: userId, status: "ACTIVE" } });
    if (!u) throw fail.validation({ userId: "Pick an active team member." });
    if (u.id === task.ownerId) throw fail.validation({ userId: "This person already owns the task." });
    await grantAccess(tx, id, u.id, "COLLABORATOR", actor.id);
    await audit(tx, { recordId: id, eventType: "ACCESS_GRANTED", actor, newValue: { userId: u.id, reason: "COLLABORATOR" } });
    return { ok: true };
  });
}

export async function revokeAccess(actor: Actor, id: string, accessId: string) {
  return runTx(async (tx) => {
    const task = await loadTask(tx, id, actor);
    if (!isOwner(task, actor) && !isPrivileged(actor)) throw fail.forbidden("Only the owner, Admin or Leadership can remove access.");
    const a = await tx.taskAccess.findFirst({ where: { id: accessId, taskId: id, revokedAt: null } });
    if (!a) throw fail.notFound("Access entry");
    await tx.taskAccess.update({ where: { id: a.id }, data: { revokedAt: new Date(), revokedById: actor.id } });
    await audit(tx, { recordId: id, eventType: "ACCESS_REVOKED", actor, previousValue: { userId: a.userId, reason: a.reason } });
    return { ok: true };
  });
}
