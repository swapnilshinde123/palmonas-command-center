import { z } from "zod";
import type { Task } from "@prisma/client";
import { prisma, tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { diffDays, iso, todayBiz, tryParseISODate } from "@/lib/dates";
import { assertCan, can, isPrivileged, type Actor } from "./rbac";
import { audit } from "./audit";
import { enqueue, governanceRecipients } from "./notifications/enqueue";
import { grantAccess, isOwner, loadTask, taskInclude, toDTO, visibleWhere } from "./task-core";
import { timeliness, TIMELINESS_LABEL } from "./sla";
import { businessDateOf, monthKey } from "@/lib/dates";
import { isActive } from "./sla";
import { changeStatusInTx } from "./tasks";
import { softDeleteInTx } from "./deletion";

async function lockRow(tx: Tx, table: "Transfer" | "ExtensionRequest" | "WaiverRequest" | "CancellationRequest", id: string) {
  // Table names are a closed union, so interpolating them is safe.
  await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);
}

const reasonRequired = (r: string | null | undefined, field = "reason", msg = "A reason is required.") => {
  if (!r?.trim()) throw fail.validation({ [field]: msg });
  return r.trim();
};

// ---------- Transfers (§4.2, §12.1, §26) ----------

export async function createTransferInTx(tx: Tx, actor: Actor, task: Task, toUserId: string, reason: string, override = false) {
  const to = await tx.user.findFirst({ where: { id: toUserId, status: "ACTIVE" } });
  if (!to) throw fail.validation({ toUserId: "Recipient must be an active team member." });
  if (to.id === task.ownerId) throw fail.validation({ toUserId: "This person already owns the task." });
  if (!isActive(task.status)) throw fail.blocked("Only active tasks can be transferred.");
  const pending = await tx.transfer.findFirst({ where: { taskId: task.id, status: "PENDING" } });
  if (pending) throw fail.conflict("A transfer is already pending for this task.");

  const today = todayBiz();
  const transfer = await tx.transfer.create({
    data: {
      taskId: task.id, fromUserId: task.ownerId, toUserId: to.id, initiatedById: actor.id, reason,
      deadlineAtRequest: task.deadline, wasOverdueAtRequest: today > task.deadline,
      status: override ? "APPROVED" : "PENDING", adminOverride: override,
      decidedById: override ? actor.id : null, decidedAt: override ? new Date() : null,
    },
  });
  await audit(tx, { recordId: task.id, eventType: "TRANSFER_REQUESTED", actor, reason, relatedEntityId: transfer.id, newValue: { from: task.ownerId, to: to.id, wasOverdueAtRequest: transfer.wasOverdueAtRequest } });
  // The proposed recipient needs to see the task to decide; access is scoped to this task only.
  await grantAccess(tx, task.id, to.id, "TRANSFER", actor.id);
  if (actor.id !== task.ownerId) await grantAccess(tx, task.id, actor.id, "TRANSFER", actor.id);
  if (override) {
    await applyOwnerChange(tx, actor, task.id, task.ownerId, to.id, transfer.id, "Admin override");
  } else {
    await enqueue(tx, {
      eventType: "TRANSFER_REQUESTED", transitionId: transfer.id, taskId: task.id, recipientIds: [to.id], actorId: actor.id,
      subject: `${actor.name} wants to transfer to you: ${task.name}`, payload: { taskId: task.id, task: task.name, from: actor.name, reason, transferId: transfer.id, action: "Accept or reject in Approvals" },
    });
  }
  return transfer;
}

async function applyOwnerChange(tx: Tx, actor: Actor, taskId: string, from: string, to: string, transferId: string, how: string) {
  await tx.task.update({ where: { id: taskId }, data: { ownerId: to, version: { increment: 1 }, updatedById: actor.id } });
  await grantAccess(tx, taskId, from, "PREVIOUS_OWNER", actor.id);
  await audit(tx, { recordId: taskId, eventType: "OWNER_CHANGED", actor, previousValue: { ownerId: from }, newValue: { ownerId: to }, relatedEntityId: transferId, reason: how });
  const t = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { name: true } });
  await enqueue(tx, {
    eventType: "TASK_ASSIGNED", transitionId: `transfer-${transferId}`, taskId, recipientIds: [to], actorId: actor.id,
    subject: `You now own: ${t.name}`, payload: { taskId, task: t.name, by: actor.name, how },
  });
}

export const transferSchema = z.object({ toUserId: z.string(), reason: z.string().nullish(), override: z.boolean().optional() });

export async function requestTransfer(actor: Actor, taskId: string, body: unknown) {
  const b = transferSchema.parse(body);
  const reason = reasonRequired(b.reason);
  return runTx(async (tx) => {
    const task = await loadTask(tx, taskId, actor, { lock: true });
    if (b.override) assertCan(actor, "TRANSFER_OVERRIDE");
    else assertCan(actor, "INITIATE_TRANSFER", isOwner(task, actor));
    const t = await createTransferInTx(tx, actor, task, b.toUserId, reason, !!b.override);
    return { transfer: t, task: toDTO(await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude })) };
  });
}

export const decisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), reason: z.string().nullish() });

export async function decideTransfer(actor: Actor, transferId: string, body: unknown) {
  const b = decisionSchema.parse(body);
  return runTx(async (tx) => {
    await lockRow(tx, "Transfer", transferId);
    const tr = await tx.transfer.findUnique({ where: { id: transferId } });
    if (!tr) throw fail.notFound("Transfer");
    assertCan(actor, "DECIDE_TRANSFER", tr.toUserId === actor.id);
    if (tr.status !== "PENDING") throw fail.conflict(`This transfer was already ${tr.status.toLowerCase()}.`);
    await tx.$executeRaw`SELECT 1 FROM "Task" WHERE "id" = ${tr.taskId} FOR UPDATE`;
    const task = await tx.task.findUniqueOrThrow({ where: { id: tr.taskId } });
    if (task.ownerId !== tr.fromUserId) throw fail.conflict("Task owner changed since this transfer was requested.");

    if (b.decision === "REJECT") {
      const reason = reasonRequired(b.reason, "reason", "Say why you're rejecting the transfer.");
      await tx.transfer.update({ where: { id: tr.id }, data: { status: "REJECTED", decidedById: actor.id, decidedAt: new Date(), rejectionReason: reason } });
      await audit(tx, { recordId: tr.taskId, eventType: "TRANSFER_REJECTED", actor, reason, relatedEntityId: tr.id });
    } else {
      await tx.transfer.update({ where: { id: tr.id }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date(), adminOverride: actor.id !== tr.toUserId } });
      await audit(tx, { recordId: tr.taskId, eventType: "TRANSFER_ACCEPTED", actor, reason: b.reason, relatedEntityId: tr.id });
      await applyOwnerChange(tx, actor, tr.taskId, tr.fromUserId, tr.toUserId, tr.id, actor.id === tr.toUserId ? "Recipient accepted" : "Override acceptance");
    }
    await enqueue(tx, {
      eventType: "TRANSFER_DECIDED", transitionId: tr.id, taskId: tr.taskId, recipientIds: [tr.initiatedById, tr.fromUserId], actorId: actor.id,
      subject: `Transfer ${b.decision === "REJECT" ? "rejected" : "accepted"}: ${task.name}`, payload: { taskId: tr.taskId, decision: b.decision, by: actor.name, reason: b.reason },
    });
    return { ok: true };
  });
}

export async function cancelTransfer(actor: Actor, transferId: string) {
  return runTx(async (tx) => {
    await lockRow(tx, "Transfer", transferId);
    const tr = await tx.transfer.findUnique({ where: { id: transferId } });
    if (!tr) throw fail.notFound("Transfer");
    if (tr.initiatedById !== actor.id && actor.role !== "ADMIN") throw fail.forbidden();
    if (tr.status !== "PENDING") throw fail.conflict("Only pending transfers can be withdrawn.");
    await tx.transfer.update({ where: { id: tr.id }, data: { status: "CANCELLED", decidedById: actor.id, decidedAt: new Date() } });
    await audit(tx, { recordId: tr.taskId, eventType: "TRANSFER_CANCELLED", actor, relatedEntityId: tr.id });
    return { ok: true };
  });
}

// ---------- Extensions & waivers (§4.3, §12.2–12.3, §27) ----------

export const extensionSchema = z.object({ requestedDeadline: z.string(), reason: z.string().nullish(), waiverReason: z.string().nullish() });

// Score impact preview for approvers; the KPI formula itself stays in the approved ScorePolicy.
async function penaltyPerExtension(tx: Tx) {
  const policy = await tx.scorePolicy.findFirst({ orderBy: { version: "desc" } });
  return Number((policy?.config as { discipline?: { penaltyPerUnwaivedExtension?: number } } | undefined)?.discipline?.penaltyPerUnwaivedExtension ?? 2);
}

export async function requestExtension(actor: Actor, taskId: string, body: unknown) {
  const b = extensionSchema.parse(body);
  const reason = reasonRequired(b.reason);
  return runTx(async (tx) => {
    const task = await loadTask(tx, taskId, actor, { lock: true });
    assertCan(actor, "REQUEST_EXTENSION", isOwner(task, actor));
    // Brief §8: allowed before or after completion (it can change the KPI outcome); never on dropped tasks.
    if (task.status === "DROPPED") throw fail.blocked("Extensions can't be requested on a dropped task.");
    const afterCompletion = task.status === "COMPLETED";
    const d = tryParseISODate(b.requestedDeadline);
    if (!d) throw fail.validation({ requestedDeadline: "Enter a valid date." });
    if (d <= task.deadline) throw fail.validation({ requestedDeadline: "The new deadline must be after the current deadline." });
    if (await tx.extensionRequest.findFirst({ where: { taskId, status: "PENDING" } })) throw fail.conflict("An extension request is already pending for this task.");

    const ext = await tx.extensionRequest.create({ data: { taskId, requestedById: actor.id, previousDeadline: task.deadline, requestedDeadline: d, reason, afterCompletion } });
    await grantAccess(tx, taskId, actor.id === task.ownerId ? null : actor.id, "EXTENSION", actor.id);
    // Submitting never changes the deadline; the current one stays authoritative until approval.
    await audit(tx, { recordId: taskId, eventType: "EXTENSION_REQUESTED", actor, reason, relatedEntityId: ext.id, previousValue: { deadline: iso(task.deadline) }, newValue: { requestedDeadline: iso(d), afterCompletion } });
    const recipients = await governanceRecipients(tx);
    await enqueue(tx, {
      eventType: "EXTENSION_REQUESTED", transitionId: ext.id, taskId, recipientIds: recipients, actorId: actor.id,
      subject: `Extension request (${diffDays(d, task.deadline)}d): ${task.name}`,
      payload: { taskId, task: task.name, requestedBy: actor.name, currentDeadline: iso(task.deadline), requestedDeadline: iso(d), days: diffDays(d, task.deadline), reason, afterCompletion, kpiImpact: `-${await penaltyPerExtension(tx)} discipline points unless a waiver is approved` },
    });
    let waiver = null;
    if (b.waiverReason?.trim()) waiver = await createWaiverInTx(tx, actor, task, b.waiverReason.trim(), ext.id);
    return { ...ext, waiverId: waiver?.id ?? null };
  });
}

// Brief §9: a waiver is its own request with its own decision. It may reference an extension
// (raised together or later) or stand alone; it never changes the deadline.
async function createWaiverInTx(tx: Tx, actor: Actor, task: Task, reason: string, extensionId: string | null) {
  if (extensionId) {
    const ext = await tx.extensionRequest.findUnique({ where: { id: extensionId } });
    if (!ext || ext.taskId !== task.id) throw fail.validation({ extensionId: "That extension isn't on this task." });
    if (ext.status === "CANCELLED") throw fail.blocked("That extension was withdrawn.");
    if (await tx.waiverRequest.findFirst({ where: { extensionId, status: { in: ["PENDING", "APPROVED"] } } })) throw fail.conflict("A waiver is already pending or approved for this extension.");
  } else if (await tx.waiverRequest.findFirst({ where: { taskId: task.id, extensionId: null, status: "PENDING" } })) {
    throw fail.conflict("A waiver request is already pending for this task.");
  }
  const w = await tx.waiverRequest.create({ data: { taskId: task.id, extensionId, requestedById: actor.id, reason } });
  await grantAccess(tx, task.id, actor.id === task.ownerId ? null : actor.id, "WAIVER", actor.id);
  await audit(tx, { recordId: task.id, eventType: "WAIVER_REQUESTED", actor, reason, relatedEntityId: w.id, newValue: { extensionId } });
  await enqueue(tx, {
    eventType: "WAIVER_REQUESTED", transitionId: w.id, taskId: task.id, recipientIds: await governanceRecipients(tx), actorId: actor.id,
    subject: `Waiver request: ${task.name}`, payload: { taskId: task.id, task: task.name, reason, by: actor.name, extensionId, note: "Decided separately from any extension" },
  });
  return w;
}

export async function requestWaiver(actor: Actor, taskId: string, body: unknown) {
  const b = z.object({ reason: z.string().nullish(), extensionId: z.string().nullish() }).parse(body);
  const reason = reasonRequired(b.reason);
  return runTx(async (tx) => {
    const task = await loadTask(tx, taskId, actor, { lock: true });
    const ext = b.extensionId ? await tx.extensionRequest.findUnique({ where: { id: b.extensionId } }) : null;
    assertCan(actor, "REQUEST_WAIVER", isOwner(task, actor) || ext?.requestedById === actor.id);
    return createWaiverInTx(tx, actor, task, reason, b.extensionId || null);
  });
}

export async function decideExtension(actor: Actor, extensionId: string, body: unknown) {
  const b = decisionSchema.parse(body);
  return runTx(async (tx) => {
    assertCan(actor, "DECIDE_EXTENSION");
    await lockRow(tx, "ExtensionRequest", extensionId);
    const ext = await tx.extensionRequest.findUnique({ where: { id: extensionId } });
    if (!ext) throw fail.notFound("Extension");
    if (ext.requestedById === actor.id) throw fail.forbidden("You can't decide your own extension request.");
    if (ext.status !== "PENDING") throw fail.conflict(`This extension was already ${ext.status.toLowerCase()}.`);
    await tx.$executeRaw`SELECT 1 FROM "Task" WHERE "id" = ${ext.taskId} FOR UPDATE`;
    const task = await tx.task.findUniqueOrThrow({ where: { id: ext.taskId } });
    const now = new Date();
    const warnings: string[] = [];

    if (b.decision === "REJECT") {
      // The deadline is untouched; any linked waiver stays pending for its own decision.
      const reason = reasonRequired(b.reason);
      await tx.extensionRequest.update({ where: { id: ext.id }, data: { status: "REJECTED", decidedById: actor.id, decidedAt: now, decisionReason: reason } });
      await audit(tx, { recordId: task.id, eventType: "EXTENSION_REJECTED", actor, reason, relatedEntityId: ext.id });
    } else {
      const waiverApproved = !!(await tx.waiverRequest.findFirst({ where: { extensionId: ext.id, status: "APPROVED" } }));
      await tx.extensionRequest.update({ where: { id: ext.id }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: now, decisionReason: b.reason ?? null, finalDeadline: ext.requestedDeadline } });
      await tx.task.update({
        where: { id: task.id },
        data: {
          deadline: ext.requestedDeadline, extensionsCount: { increment: 1 },
          ...(waiverApproved ? { waivedExtensionsCount: { increment: 1 } } : {}),
          version: { increment: 1 }, updatedById: actor.id,
        },
      });
      await audit(tx, { recordId: task.id, eventType: "EXTENSION_APPROVED", actor, reason: b.reason, relatedEntityId: ext.id, previousValue: { deadline: iso(task.deadline), originalDeadline: iso(task.originalDeadline), extensionsCount: task.extensionsCount }, newValue: { deadline: iso(ext.requestedDeadline), extensionsCount: task.extensionsCount + 1, waiverApproved } });
      await audit(tx, { recordId: task.id, eventType: "DEADLINE_CHANGED", actor, previousValue: iso(task.deadline), newValue: iso(ext.requestedDeadline), relatedEntityId: ext.id, reason: "Extension approved" });
      if (task.status === "COMPLETED" && task.completedAt) {
        // Post-completion approval: status and completion time stay as they were; only the KPI outcome moves.
        const before = timeliness(task, businessDateOf(task.completedAt));
        const after = timeliness({ ...task, deadline: ext.requestedDeadline }, businessDateOf(task.completedAt));
        const month = monthKey(businessDateOf(task.completedAt));
        const closed = !!(await tx.scorecardPeriod.findUnique({ where: { month } }));
        if (closed) warnings.push(`Completed in closed KPI period ${month}. The frozen scorecard is unchanged; an admin must post a correction.`);
        await audit(tx, { recordId: task.id, eventType: "KPI_ADJUSTMENT", actor, relatedEntityId: ext.id, reason: "Extension approved after completion", previousValue: { timeliness: TIMELINESS_LABEL[before] }, newValue: { timeliness: TIMELINESS_LABEL[after], period: month, periodClosed: closed } });
      }
      await enqueue(tx, {
        eventType: "DEADLINE_CHANGED", transitionId: `ext-${ext.id}`, taskId: task.id, recipientIds: [task.ownerId], actorId: actor.id,
        subject: `Deadline moved to ${iso(ext.requestedDeadline)}: ${task.name}`, payload: { taskId: task.id, task: task.name, before: iso(task.deadline), after: iso(ext.requestedDeadline), by: actor.name, reason: "Extension approved" },
      });
    }
    await enqueue(tx, {
      eventType: "EXTENSION_DECIDED", transitionId: ext.id, taskId: task.id, recipientIds: [ext.requestedById, task.ownerId], actorId: actor.id,
      subject: `Extension ${b.decision === "REJECT" ? "rejected" : "approved"}: ${task.name}`, payload: { taskId: task.id, task: task.name, decision: b.decision, by: actor.name, reason: b.reason, requestedDeadline: iso(ext.requestedDeadline), deadlineNow: b.decision === "REJECT" ? iso(task.deadline) : iso(ext.requestedDeadline) },
    });
    return { ok: true, warnings };
  });
}

export async function decideWaiver(actor: Actor, waiverId: string, body: unknown) {
  const b = decisionSchema.parse(body);
  return runTx(async (tx) => {
    assertCan(actor, "DECIDE_WAIVER");
    await lockRow(tx, "WaiverRequest", waiverId);
    const w = await tx.waiverRequest.findUnique({ where: { id: waiverId }, include: { extension: true, task: { select: { name: true, ownerId: true } } } });
    if (!w) throw fail.notFound("Waiver");
    if (w.requestedById === actor.id || w.extension?.requestedById === actor.id) throw fail.forbidden("Self-approval of waivers is blocked.");
    if (w.status !== "PENDING") throw fail.conflict(`This waiver was already ${w.status.toLowerCase()}.`);
    const now = new Date();
    if (b.decision === "REJECT") {
      // Rejecting a waiver never touches the extension (brief §9).
      const reason = reasonRequired(b.reason);
      await tx.waiverRequest.update({ where: { id: w.id }, data: { status: "REJECTED", decidedById: actor.id, decidedAt: now, decisionReason: reason } });
      await audit(tx, { recordId: w.taskId, eventType: "WAIVER_REJECTED", actor, reason, relatedEntityId: w.id });
    } else {
      await tx.waiverRequest.update({ where: { id: w.id }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: now, decisionReason: b.reason ?? null } });
      // Only an approved extension carries a penalty to offset; a pending one picks the waiver up on approval.
      if (w.extension?.status === "APPROVED")
        await tx.task.update({ where: { id: w.taskId }, data: { waivedExtensionsCount: { increment: 1 }, version: { increment: 1 }, updatedById: actor.id } });
      await audit(tx, { recordId: w.taskId, eventType: "WAIVER_APPROVED", actor, reason: b.reason, relatedEntityId: w.id, newValue: { extensionId: w.extensionId, extensionStatus: w.extension?.status ?? null } });
    }
    await enqueue(tx, {
      eventType: "WAIVER_DECIDED", transitionId: w.id, taskId: w.taskId, recipientIds: [w.requestedById, w.task.ownerId], actorId: actor.id,
      subject: `Waiver ${b.decision === "REJECT" ? "rejected" : "approved"}: ${w.task.name}`, payload: { taskId: w.taskId, task: w.task.name, decision: b.decision, by: actor.name, reason: b.reason },
    });
    return { ok: true };
  });
}

// ---------- Cancellation requests (member path to drop/delete) ----------

export const cancellationSchema = z.object({ kind: z.enum(["DROP", "DELETE"]), reason: z.string().nullish() });

export async function requestCancellation(actor: Actor, taskId: string, body: unknown) {
  const b = cancellationSchema.parse(body);
  const reason = reasonRequired(b.reason);
  return runTx(async (tx) => {
    const task = await loadTask(tx, taskId, actor, { lock: true });
    assertCan(actor, "REQUEST_CANCELLATION", isOwner(task, actor));
    if (await tx.cancellationRequest.findFirst({ where: { taskId, status: "PENDING" } })) throw fail.conflict("A cancellation request is already pending.");
    const c = await tx.cancellationRequest.create({ data: { taskId, requestedById: actor.id, kind: b.kind, reason } });
    await audit(tx, { recordId: taskId, eventType: "CANCELLATION_REQUESTED", actor, reason, relatedEntityId: c.id, newValue: { kind: b.kind } });
    await enqueue(tx, { eventType: "CANCELLATION_REQUESTED", transitionId: c.id, taskId, actorId: actor.id, recipientIds: await governanceRecipients(tx), subject: `Cancellation request: ${task.name}`, payload: { taskId, kind: b.kind, reason, by: actor.name } });
    return c;
  });
}

export async function decideCancellation(actor: Actor, id: string, body: unknown) {
  const b = decisionSchema.parse(body);
  return runTx(async (tx) => {
    assertCan(actor, "DECIDE_CANCELLATION");
    await lockRow(tx, "CancellationRequest", id);
    const c = await tx.cancellationRequest.findUnique({ where: { id } });
    if (!c) throw fail.notFound("Cancellation request");
    if (c.requestedById === actor.id) throw fail.forbidden("You can't decide your own request.");
    if (c.status !== "PENDING") throw fail.conflict("Already decided.");
    const now = new Date();
    if (b.decision === "REJECT") {
      const reason = reasonRequired(b.reason);
      await tx.cancellationRequest.update({ where: { id }, data: { status: "REJECTED", decidedById: actor.id, decidedAt: now, decisionReason: reason } });
      await audit(tx, { recordId: c.taskId, eventType: "CANCELLATION_REJECTED", actor, reason, relatedEntityId: id });
      return { ok: true };
    }
    await tx.cancellationRequest.update({ where: { id }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: now, decisionReason: b.reason ?? null } });
    await audit(tx, { recordId: c.taskId, eventType: "CANCELLATION_APPROVED", actor, reason: b.reason, relatedEntityId: id });
    const task = await tx.task.findUniqueOrThrow({ where: { id: c.taskId } });
    const why = `Cancellation request ${id}: ${c.reason}`;
    if (c.kind === "DROP") await changeStatusInTx(tx, actor, c.taskId, { to: "DROPPED", expectedVersion: task.version, reason: why }, { viaCancellation: true });
    else await softDeleteInTx(tx, actor, c.taskId, why);
    return { ok: true };
  });
}

// ---------- Approvals inbox ----------

export async function approvalsInbox(actor: Actor) {
  const priv = isPrivileged(actor);
  const taskSel = { select: { id: true, name: true, ownerId: true, deadline: true, extensionsCount: true, waivedExtensionsCount: true, owner: { select: { name: true } } } };
  const [transfers, extensions, waivers, cancellations, users] = await Promise.all([
    prisma.transfer.findMany({ where: { status: "PENDING", ...(priv ? {} : { OR: [{ toUserId: actor.id }, { initiatedById: actor.id }] }) }, include: { task: taskSel }, orderBy: { requestedAt: "asc" } }),
    prisma.extensionRequest.findMany({ where: { status: "PENDING", task: { softDeleted: false }, ...(priv ? {} : { requestedById: actor.id }) }, include: { task: taskSel, waivers: true }, orderBy: { requestedAt: "asc" } }),
    prisma.waiverRequest.findMany({ where: { status: "PENDING", ...(priv ? {} : { requestedById: actor.id }) }, include: { task: taskSel, extension: true }, orderBy: { requestedAt: "asc" } }),
    prisma.cancellationRequest.findMany({ where: { status: "PENDING", ...(priv ? {} : { requestedById: actor.id }) }, include: { task: taskSel }, orderBy: { requestedAt: "asc" } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const policy = await prisma.scorePolicy.findFirst({ orderBy: { version: "desc" } });
  const perExt = Number((policy?.config as { discipline?: { penaltyPerUnwaivedExtension?: number } } | undefined)?.discipline?.penaltyPerUnwaivedExtension ?? 2);
  return {
    names,
    transfers: transfers.map((t) => ({ ...t, deadlineAtRequest: iso(t.deadlineAtRequest), canDecide: can(actor, "DECIDE_TRANSFER", t.toUserId === actor.id), canWithdraw: t.initiatedById === actor.id || actor.role === "ADMIN", task: { ...t.task, deadline: iso(t.task.deadline) } })),
    extensions: extensions.map((e) => ({
      ...e, previousDeadline: iso(e.previousDeadline), requestedDeadline: iso(e.requestedDeadline), finalDeadline: iso(e.finalDeadline),
      diffDays: diffDays(e.requestedDeadline, e.previousDeadline), penaltyPreview: -perExt,
      canDecide: can(actor, "DECIDE_EXTENSION") && e.requestedById !== actor.id,
      task: { ...e.task, deadline: iso(e.task.deadline) },
    })),
    waivers: waivers.map((w) => ({ ...w, canDecide: can(actor, "DECIDE_WAIVER") && w.requestedById !== actor.id && w.extension?.requestedById !== actor.id, task: { ...w.task, deadline: iso(w.task.deadline) } })),
    cancellations: cancellations.map((c) => ({ ...c, canDecide: can(actor, "DECIDE_CANCELLATION") && c.requestedById !== actor.id, task: { ...c.task, deadline: iso(c.task.deadline) } })),
  };
}

export { visibleWhere };
