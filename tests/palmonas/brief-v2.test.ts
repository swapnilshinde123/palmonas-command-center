import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commandCenter, dueView } from "@/domain/command";
import { addCollaborator, changeStatus, getTaskDetail, listTasks, revokeAccess, setFlag, setStar, updateTask } from "@/domain/tasks";
import { decideExtension, decideTransfer, decideWaiver, requestExtension, requestTransfer, requestWaiver } from "@/domain/governance";
import { escalationsView, reassignEscalation, resolveEscalation, triggerEscalation } from "@/domain/escalation";
import { decidePromotion, pendingFromView, requestPromotion } from "@/domain/poc";
import { hardDelete, listBin, restore, softDelete } from "@/domain/deletion";
import { createSeries, seriesAction } from "@/domain/recurrence";
import { listBell } from "@/domain/bell";
import { processQueue } from "@/domain/notifications/processor";
import { resetTransportForTests } from "@/domain/notifications/mailer";
import { setUserStatus } from "@/domain/users";
import { loadActor } from "@/domain/actor";
import { channel, actors, backdate, day, emailOn, expectError, mkTask, version } from "./helpers";

describe("Command Center (brief §3)", () => {
  it("UI-001/UI-002 members see aggregate counts only, Owner → Channel → Priority, no drill-down", async () => {
    const { harsh, pragati, ritesh } = await actors();
    await mkTask(harsh, { ownerId: ritesh.id, name: "Ritesh confidential pricing work" });
    await mkTask(pragati);
    const cc = await commandCenter(pragati);
    expect(cc.drilldown).toBe(false);
    expect(Object.keys(cc).indexOf("owners")).toBeLessThan(Object.keys(cc).indexOf("channels"));
    expect(Object.keys(cc).indexOf("channels")).toBeLessThan(Object.keys(cc).indexOf("priorities"));
    expect(cc.owners.find((o) => o.label === "Ritesh")!.active).toBe(1);
    // No task-level content in the aggregate payload, and the recent feed only shows her own work.
    expect(JSON.stringify({ ...cc, recent: [] })).not.toContain("confidential");
    expect(cc.recent.every((r) => !r.task.includes("confidential"))).toBe(true);
    // Drilling into Ritesh's tasks from a count is refused at the API.
    await expectError(listTasks(pragati, { view: "team", ownerId: ritesh.id }), "FORBIDDEN");
    await expectError(listTasks(pragati, { ownerId: ritesh.id }), "FORBIDDEN");
  });

  it("UI-003 Leadership can drill down, but their task list still defaults to their own tasks", async () => {
    const { dilip, harsh, ritesh } = await actors();
    await mkTask(harsh, { ownerId: ritesh.id });
    await mkTask(dilip);
    expect((await commandCenter(dilip)).drilldown).toBe(true);
    expect((await listTasks(dilip, {})).every((t) => t.owner.id === dilip.id)).toBe(true);
    expect((await listTasks(dilip, { view: "team", ownerId: ritesh.id }))).toHaveLength(1);
  });
});

describe("task visibility & contextual access (brief §2)", () => {
  it("UI-004 a member can't read another member's task by ID, list, search or status change", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(harsh, { ownerId: ritesh.id, name: "Ritesh only" });
    await expectError(getTaskDetail(pragati, t.id), "NOT_FOUND");
    expect(await listTasks(pragati, { view: "all", q: "Ritesh only" })).toHaveLength(0);
    await expectError(changeStatus(pragati, t.id, { to: "IN_PROGRESS", expectedVersion: t.version }), "NOT_FOUND");
    await expectError(updateTask(pragati, t.id, { expectedVersion: t.version, patch: { name: "hijack" } }), "NOT_FOUND");
  });

  it("UI-005 contextual access opens one task only, is revocable, and dies with deactivation", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const shared = await mkTask(ritesh, { name: "Shared with Pragati" });
    const other = await mkTask(ritesh, { name: "Ritesh's other task" });
    await addCollaborator(ritesh, shared.id, { userId: pragati.id });
    expect((await getTaskDetail(pragati, shared.id)).task.id).toBe(shared.id);
    await expectError(getTaskDetail(pragati, other.id), "NOT_FOUND");
    expect((await listTasks(pragati, { view: "shared" })).map((t) => t.id)).toEqual([shared.id]);
    const detail = await getTaskDetail(ritesh, shared.id);
    await revokeAccess(ritesh, shared.id, detail.access.find((a) => a.userId === pragati.id)!.id);
    await expectError(getTaskDetail(pragati, shared.id), "NOT_FOUND");
    await addCollaborator(ritesh, shared.id, { userId: pragati.id });
    await setUserStatus(harsh, pragati.id, { status: "DEACTIVATED", reason: "Left" });
    expect(await loadActor(pragati.id)).toBeNull();
  });
});

describe("Pending From & POC registry (brief §6)", () => {
  it("UI-006/UI-007 pending needs both POC Type and POC Name; neither is needed when not pending", async () => {
    const { pragati } = await actors();
    const ch = await channel();
    const base = { name: "Pending task", channelId: ch, ownerId: pragati.id, priority: 3, deadline: day(3) };
    const { createTask } = await import("@/domain/tasks");
    await expectError(createTask(pragati, { ...base, pendingFrom: "Amazon SPOC" }), "VALIDATION", "pocType");
    await expectError(createTask(pragati, { ...base, pocType: "E" }), "VALIDATION", "pendingFrom");
    const ok = await mkTask(pragati);
    expect(ok.pocType).toBeNull();
    await expectError(updateTask(pragati, ok.id, { expectedVersion: ok.version, patch: { pocType: "I" } }), "VALIDATION", "pendingFrom");
  });

  it("UI-008/UI-014 custom POC stays task-scoped and lands under External, not in Escalations", async () => {
    const { pragati, dilip } = await actors();
    const t = await mkTask(pragati, { pocType: "E", pendingFrom: "Courier partner (BlueDart)" });
    const poc = await prisma.poc.findFirstOrThrow({ where: { name: "Courier partner (BlueDart)" } });
    expect(poc.isRegistry).toBe(false);
    expect(poc.taskId).toBe(t.id);
    const view = await pendingFromView(pragati, { type: "E" });
    expect(view.rows.map((r) => r.id)).toEqual([t.id]);
    expect((await escalationsView(dilip, {})).rows).toHaveLength(0);
    // A registry POC picked by ID reuses the registry row.
    const reg = await prisma.poc.findFirstOrThrow({ where: { isRegistry: true, type: "I" } });
    const t2 = await mkTask(pragati, { pocType: "I", pocId: reg.id });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t2.id } })).pocId).toBe(reg.id);
  });

  it("UI-009/UI-010 only L1 promotes, and only after ticking the non-duplicate declaration", async () => {
    const { pragati, ritesh, harsh } = await actors();
    await mkTask(pragati, { pocType: "WB", pendingFrom: "Brand photo studio" });
    const poc = await prisma.poc.findFirstOrThrow({ where: { name: "Brand photo studio" } });
    await requestPromotion(pragati, poc.id, { organisation: "Palmonas" });
    await expectError(decidePromotion(harsh, poc.id, { decision: "APPROVE", verifiedNotDuplicate: true }), "FORBIDDEN");
    await expectError(decidePromotion(ritesh, poc.id, { decision: "APPROVE" }), "VALIDATION", "verifiedNotDuplicate");
    await decidePromotion(ritesh, poc.id, { decision: "APPROVE", verifiedNotDuplicate: true });
    const after = await prisma.poc.findUniqueOrThrow({ where: { id: poc.id } });
    expect(after).toMatchObject({ isRegistry: true, verifiedNotDuplicate: true, promotedById: ritesh.id });
    expect(after.promotedAt).toBeTruthy();
  });
});

describe("Escalations (brief §7)", () => {
  it("UI-011/UI-012/UI-013 direct L2/L3 assignment, reassignment with reason and full history", async () => {
    const { pragati, harsh, dilip, ritesh, riya } = await actors();
    const a = await mkTask(pragati, { name: "Needs L2" });
    expect((await triggerEscalation(pragati, a.id, { level: "L2", reason: "Ads account locked" })).assignee.id).toBe(harsh.id);
    const b = await mkTask(riya, { name: "Straight to L3" });
    const { escalationId } = await triggerEscalation(riya, b.id, { level: "L3", reason: "Marketplace delisting threat" });
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: escalationId } })).assigneeId).toBe(dilip.id);
    // Escalation owner can see the task through the escalation, without seeing Riya's other work.
    expect((await getTaskDetail(dilip, b.id)).task.escalationLevel).toBe("L3");
    await expectError(reassignEscalation(pragati, escalationId, { level: "L1", reason: "x" }), "FORBIDDEN");
    await expectError(reassignEscalation(ritesh, escalationId, { level: "L1" }), "VALIDATION", "reason");
    await reassignEscalation(ritesh, escalationId, { level: "L1", reason: "Ritesh can unblock with the KAM" });
    const hist = (await escalationsView(dilip, {})).rows.find((r) => r.id === escalationId)!.history;
    expect(hist.map((h) => `${h.from}->${h.to}`)).toEqual(["L0->L3", "L3->L1"]);
    expect(await prisma.auditEvent.count({ where: { recordId: b.id, eventType: "ESCALATION_REASSIGNED" } })).toBe(1);
    await resolveEscalation(ritesh, escalationId, { remarks: "KAM restored listing" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("NOT_STARTED");
  });
});

describe("Extensions & waivers (brief §8–§9)", () => {
  it("UI-015/UI-020 a request never moves the deadline; direct edits are refused", async () => {
    const { pragati, dilip } = await actors();
    const t = await mkTask(pragati);
    await expectError(updateTask(pragati, t.id, { expectedVersion: t.version, patch: { deadline: day(20) }, reason: "need time" }), "FORBIDDEN");
    await expectError(updateTask(dilip, t.id, { expectedVersion: t.version, patch: { deadline: day(20) }, reason: "need time" }), "FORBIDDEN");
    await requestExtension(pragati, t.id, { requestedDeadline: day(9), reason: "Waiting on catalog feed" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).deadline.toISOString().slice(0, 10)).toBe(day(3));
  });

  it("UI-016/UI-017 post-completion request: task stays completed; approval moves KPI outcome with an audit trail", async () => {
    const { pragati, dilip } = await actors();
    const t = await mkTask(pragati);
    await backdate(t.id, { assignedDate: day(-6), deadline: day(-3) });
    await changeStatus(pragati, t.id, { to: "COMPLETED", expectedVersion: await version(t.id) });
    const completed = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    const ext = await requestExtension(pragati, t.id, { requestedDeadline: day(1), reason: "Late inputs from marketplace" });
    expect(ext.afterCompletion).toBe(true);
    await decideExtension(dilip, ext.id, { decision: "APPROVE" });
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt!.toISOString()).toBe(completed.completedAt!.toISOString());
    expect(after.originalDeadline.toISOString().slice(0, 10)).toBe(day(-3));
    const adj = await prisma.auditEvent.findFirstOrThrow({ where: { recordId: t.id, eventType: "KPI_ADJUSTMENT" } });
    expect(adj.previousValue).toMatchObject({ timeliness: "Completed Late" });
    expect(adj.newValue).toMatchObject({ timeliness: "On-Time / Early" });
    expect(await prisma.waiverRequest.count({ where: { taskId: t.id } })).toBe(0);
  });

  it("UI-018/UI-019 waiver decided independently; rejection never reverses the extension; later waiver links to it", async () => {
    const { pragati, dilip, harsh } = await actors();
    const t = await mkTask(pragati);
    const ext = await requestExtension(pragati, t.id, { requestedDeadline: day(8), reason: "Vendor outage", waiverReason: "Outage outside our control" });
    await decideExtension(dilip, ext.id, { decision: "APPROVE" });
    const w1 = await prisma.waiverRequest.findFirstOrThrow({ where: { extensionId: ext.id } });
    await decideWaiver(harsh, w1.id, { decision: "REJECT", reason: "Outage was announced in advance" });
    expect((await prisma.extensionRequest.findUniqueOrThrow({ where: { id: ext.id } })).status).toBe("APPROVED");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).waivedExtensionsCount).toBe(0);
    // A second, later waiver against the same approved extension is its own record.
    const w2 = await requestWaiver(pragati, t.id, { extensionId: ext.id, reason: "New evidence: vendor confirmed unplanned outage" });
    expect(w2.id).not.toBe(w1.id);
    await decideWaiver(dilip, w2.id, { decision: "APPROVE" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).waivedExtensionsCount).toBe(1);
    const types = (await prisma.auditEvent.findMany({ where: { recordId: t.id }, orderBy: { seq: "asc" } })).map((e) => e.eventType);
    expect(types.filter((x) => x.startsWith("WAIVER"))).toEqual(["WAIVER_REQUESTED", "WAIVER_REJECTED", "WAIVER_REQUESTED", "WAIVER_APPROVED"]);
  });
});

describe("Recurring skip/pause & Due Soon (brief §5, §10)", () => {
  it("UI-021/UI-022 skip and pause are blocked without a follow-up date; follow-ups show in Due Soon", async () => {
    const { pragati } = await actors();
    const s = await createSeries(pragati, { title: "Daily OOS check", channelId: await channel(), ownerId: pragati.id, priority: 3, cadence: "DAILY", startDate: day(1) });
    await expectError(seriesAction(pragati, s.id, { action: "SKIP", date: day(2), reason: "Holiday" }), "VALIDATION", "followupDate");
    await seriesAction(pragati, s.id, { action: "SKIP", date: day(2), reason: "Holiday", followupDate: day(1) });
    await expectError(seriesAction(pragati, s.id, { action: "PAUSE", reason: "Freeze" }), "VALIDATION", "followupDate");
    await seriesAction(pragati, s.id, { action: "PAUSE", reason: "Freeze", followupDate: day(2) });
    const due = await dueView(pragati);
    expect(due.seriesFollowups.map((f) => f.kind)).toEqual(expect.arrayContaining([expect.stringMatching(/^Skipped/), expect.stringMatching(/^Paused/)]));
  });

  it("Due Soon lists deadline and follow-up reasons separately and keeps overdue tasks", async () => {
    const { pragati } = await actors();
    const a = await mkTask(pragati, { name: "Deadline soon", deadline: day(1) });
    const b = await mkTask(pragati, { name: "Follow-up soon", deadline: day(20), followupDate: day(0) });
    const c = await mkTask(pragati, { name: "Overdue one" });
    await backdate(c.id, { assignedDate: day(-5), deadline: day(-1) });
    await mkTask(pragati, { name: "Far away", deadline: day(30) });
    const due = await dueView(pragati);
    const by = Object.fromEntries(due.tasks.map((t) => [t.id, t.reasons]));
    expect(by[a.id]).toEqual(["Deadline approaching"]);
    expect(by[b.id]).toEqual(["Follow-up due"]);
    expect(by[c.id]).toEqual(["Overdue"]);
    expect(due.tasks).toHaveLength(3);
  });
});

describe("Flag, star, bin (brief §4, §12)", () => {
  it("UI-026/UI-027 only Admin/Leadership star; members never see star state; flag is separate", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(pragati);
    await expectError(setStar(pragati, t.id, { starred: true }), "FORBIDDEN");
    await setStar(harsh, t.id, { starred: true });
    expect((await listTasks(harsh, { view: "team", starred: "true" })).map((x) => x.id)).toEqual([t.id]);
    await expectError(listTasks(pragati, { starred: "true" }), "FORBIDDEN");
    expect((await getTaskDetail(pragati, t.id)).task.starred).toBe(false);
    await setFlag(pragati, t.id, { flagged: true });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect([row.flagged, row.escalationRequired]).toEqual([true, false]);
    expect(await prisma.auditEvent.count({ where: { recordId: t.id, eventType: { in: ["TASK_STARRED", "TASK_FLAGGED"] } } })).toBe(2);
  });

  it("UI-023/UI-024/UI-025 bin, inline restore without duplicates, purge denied and audited for non-admins", async () => {
    const { harsh, dilip, pragati } = await actors();
    const t = await mkTask(pragati);
    await softDelete(dilip, t.id, { reason: "Duplicate entry" });
    expect((await listBin(dilip)).rows.map((r) => r.id)).toEqual([t.id]);
    await restore(dilip, t.id, { reason: "Not a duplicate" });
    expect(await prisma.task.count()).toBe(1);
    await softDelete(dilip, t.id, { reason: "Duplicate entry" });
    await expectError(hardDelete(dilip, t.id, { confirmId: t.id, reason: "cleanup" }), "FORBIDDEN");
    await expectError(hardDelete(pragati, t.id, { confirmId: t.id, reason: "cleanup" }), "FORBIDDEN");
    expect(await prisma.auditEvent.count({ where: { recordId: t.id, eventType: "TASK_PURGE_DENIED" } })).toBe(2);
    await hardDelete(harsh, t.id, { confirmId: t.id, reason: "Confirmed duplicate" });
    expect(await prisma.auditEvent.count({ where: { recordId: t.id, eventType: "TASK_HARD_DELETED" } })).toBe(1);
  });
});

describe("Notifications (brief §14)", () => {
  it("UI-028/UI-029 transfer acceptance and priority change notify once (in-app + email outbox)", async () => {
    await emailOn();
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(pragati);
    const { transfer } = await requestTransfer(pragati, t.id, { toUserId: ritesh.id, reason: "Ritesh owns Blinkit" });
    await decideTransfer(harsh, transfer.id, { decision: "APPROVE" });
    expect(await prisma.notificationEvent.count({ where: { eventType: "TASK_ASSIGNED", recipientId: ritesh.id } })).toBe(1);
    expect((await listBell(ritesh, {})).rows.some((n) => n.eventType === "TASK_ASSIGNED")).toBe(true);
    await updateTask(harsh, t.id, { expectedVersion: await version(t.id), patch: { priority: 1 } });
    expect(await prisma.notificationEvent.count({ where: { eventType: "PRIORITY_CHANGED", recipientId: ritesh.id } })).toBe(1);
    // Email subjects carry the event and task ID only, never the task title.
    const ev = await prisma.notificationEvent.findFirstOrThrow({ where: { eventType: "PRIORITY_CHANGED" } });
    expect(ev.subject).toBe(`[Palmonas] Priority changed · ${t.id}`);
  });

  it("UI-030/UI-031 provider failure keeps the event retryable, the bell entry exists, retries never double-send", async () => {
    await emailOn();
    const { harsh, ritesh } = await actors();
    let calls = 0;
    const sent: string[] = [];
    resetTransportForTests({ sendMail: async (m: { to: string }) => { calls++; if (calls === 1) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); sent.push(m.to); return { messageId: "ok" }; } } as never);
    const t = await mkTask(harsh, { ownerId: ritesh.id });
    expect((await processQueue()).failed).toBe(1);
    expect(await prisma.inAppNotification.count({ where: { userId: ritesh.id, taskId: t.id } })).toBe(1);
    await prisma.notificationEvent.updateMany({ data: { nextAttemptAt: new Date() } });
    await Promise.all([processQueue(), processQueue()]);
    await processQueue();
    expect(sent).toHaveLength(1);
    resetTransportForTests(null);
  });

  it("email delivery off: events are recorded as skipped, so enabling later sends no backlog", async () => {
    const { harsh, ritesh } = await actors();
    await mkTask(harsh, { ownerId: ritesh.id });
    expect(await prisma.notificationEvent.count({ where: { status: "SKIPPED", errorCategory: "EMAIL_OFF" } })).toBe(1);
    await emailOn();
    expect((await processQueue()).claimed).toBe(0);
  });

  it("UI-032 a notification for a task whose access was revoked hides the task", async () => {
    const { ritesh, pragati } = await actors();
    const t = await mkTask(ritesh, { name: "Shared briefly" });
    await addCollaborator(ritesh, t.id, { userId: pragati.id });
    await updateTask(ritesh, t.id, { expectedVersion: await version(t.id), patch: { followupDate: day(1) } });
    // Pragati isn't the owner, so she gets no POC/follow-up ping; transfer-style events are used instead.
    await requestTransfer(ritesh, t.id, { toUserId: pragati.id, reason: "Cover while I'm away" });
    const before = await listBell(pragati, {});
    expect(before.rows.find((n) => n.taskId === t.id)).toBeTruthy();
    const d = await getTaskDetail(ritesh, t.id);
    for (const a of d.access.filter((x) => x.userId === pragati.id)) await revokeAccess(ritesh, t.id, a.id);
    const after = await listBell(pragati, {});
    expect(after.rows.every((n) => n.taskId !== t.id && !n.title.includes("Shared briefly"))).toBe(true);
  });

  it("no notification reaches someone who can't see the task", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(ritesh);
    await updateTask(harsh, t.id, { expectedVersion: await version(t.id), patch: { priority: 0 }, reason: "Revenue blocker" });
    expect(await prisma.inAppNotification.count({ where: { userId: pragati.id } })).toBe(0);
  });
});

describe("Concurrency & channels (brief §19 multi-user)", () => {
  it("UI-033 simultaneous edits: the second write gets STALE instead of overwriting", async () => {
    const { harsh, dilip, pragati } = await actors();
    const t = await mkTask(pragati);
    const v = t.version;
    await updateTask(harsh, t.id, { expectedVersion: v, patch: { name: "Harsh's title" } });
    const err = await expectError(updateTask(dilip, t.id, { expectedVersion: v, patch: { name: "Dilip's title" } }), "STALE");
    expect((err.details as { name: string }).name).toBe("Harsh's title");
  });

  it("UI-034 channel counts are visible, but channel records stay permission-filtered", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const ch = await channel("Myntra");
    await mkTask(harsh, { ownerId: ritesh.id, channelId: ch });
    await mkTask(pragati, { channelId: ch });
    const cc = await commandCenter(pragati);
    expect(cc.channels.find((c) => c.label === "Myntra")!.active).toBe(2);
    expect(await listTasks(pragati, { view: "all", channelId: ch })).toHaveLength(1);
  });
});

describe("Escalation owners' visibility", () => {
  it("an L1 owner can open and reassign any active escalation, and loses sight of it once resolved", async () => {
    const { riya, ritesh, dilip } = await actors();
    const t = await mkTask(riya, { name: "Escalated to L3" });
    const { escalationId } = await triggerEscalation(riya, t.id, { level: "L3", reason: "Urgent" });
    expect((await getTaskDetail(ritesh, t.id)).permissions.reassignEscalation).toBe(true);
    await resolveEscalation(dilip, escalationId, { remarks: "Done" });
    await expectError(getTaskDetail(ritesh, t.id), "NOT_FOUND");
    const other = await mkTask(riya, { name: "Never escalated" });
    await expectError(getTaskDetail(ritesh, other.id), "NOT_FOUND");
  });
});
