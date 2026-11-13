import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requestTransfer, decideTransfer, requestExtension, decideExtension, requestWaiver, decideWaiver, requestCancellation, decideCancellation } from "@/domain/governance";
import { changeStatus } from "@/domain/tasks";
import { computeMonth } from "@/domain/scorecard";
import { monthKey, todayBiz } from "@/lib/dates";
import { actors, backdate, day, expectError, mkTask, version } from "./helpers";

describe("transfers (§12.1, §26)", () => {
  it("QA-012 member cannot perform admin-only actions via the service layer", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    await expectError(requestTransfer(pragati, t.id, { toUserId: ritesh.id, reason: "x", override: true }), "FORBIDDEN");
    await expectError(changeStatus(pragati, t.id, { to: "DROPPED", expectedVersion: t.version, reason: "x" }), "FORBIDDEN");
  });

  it("QA-013/014 pending transfer keeps owner; acceptance changes owner once", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    const { transfer } = await requestTransfer(pragati, t.id, { toUserId: ritesh.id, reason: "Ritesh owns Blinkit" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId).toBe(pragati.id);
    await expectError(requestTransfer(pragati, t.id, { toUserId: ritesh.id, reason: "dup" }), "CONFLICT");
    await expectError(decideTransfer(pragati, transfer.id, { decision: "APPROVE" }), "FORBIDDEN");
    await decideTransfer(ritesh, transfer.id, { decision: "APPROVE" });
    await expectError(decideTransfer(ritesh, transfer.id, { decision: "APPROVE" }), "CONFLICT");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId).toBe(ritesh.id);
    expect(await prisma.auditEvent.count({ where: { recordId: t.id, eventType: "OWNER_CHANGED" } })).toBe(1);
    // Ritesh accepted it himself, so he isn't notified; the previous owner hears about the decision and keeps history access.
    expect(await prisma.notificationEvent.count({ where: { eventType: "TASK_ASSIGNED", recipientId: ritesh.id } })).toBe(0);
    expect(await prisma.inAppNotification.count({ where: { eventType: "TRANSFER_DECIDED", userId: pragati.id } })).toBe(1);
    expect(await prisma.taskAccess.count({ where: { taskId: t.id, userId: pragati.id, reason: "PREVIOUS_OWNER" } })).toBe(1);
  });

  it("QA-015 rejection leaves the owner and records the reason", async () => {
    const { pragati, ritesh } = await actors();
    const t = await mkTask(pragati);
    const { transfer } = await requestTransfer(pragati, t.id, { toUserId: ritesh.id, reason: "help" });
    await expectError(decideTransfer(ritesh, transfer.id, { decision: "REJECT" }), "VALIDATION", "reason");
    await decideTransfer(ritesh, transfer.id, { decision: "REJECT", reason: "At capacity" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId).toBe(pragati.id);
    expect((await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } })).rejectionReason).toBe("At capacity");
  });

  it("admin override reassigns instantly and is logged as override", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    await requestTransfer(harsh, t.id, { toUserId: ritesh.id, reason: "Leave cover", override: true });
    const tr = await prisma.transfer.findFirstOrThrow({ where: { taskId: t.id } });
    expect(tr.adminOverride).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId).toBe(ritesh.id);
  });

  it("QA-043/QA-044/QA-016 overdue transfer: delay stays with sender, delivery credit to recipient in completion month", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    await backdate(t.id, { assignedDate: day(-10), deadline: day(-2) });
    const { transfer } = await requestTransfer(pragati, t.id, { toUserId: ritesh.id, reason: "handover" });
    expect(transfer.wasOverdueAtRequest).toBe(true);
    await decideTransfer(ritesh, transfer.id, { decision: "APPROVE" });
    await changeStatus(ritesh, t.id, { to: "COMPLETED", expectedVersion: await version(t.id) });
    const { rows } = await computeMonth(monthKey(todayBiz()));
    const p = rows.find((r) => r.userId === pragati.id)!;
    const r = rows.find((x) => x.userId === ritesh.id)!;
    expect(p.inheritedDelays).toBe(1);
    expect(p.completedLate + p.completedOnTime).toBe(0);
    expect(r.completedLate).toBe(1);
    expect(r.evidence.completedTasks).toContain(t.id);
  });
});

describe("extensions & waivers (§12.2–12.3, §27)", () => {
  it("QA-017/018 request does not move the deadline; approval moves it exactly once", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(pragati);
    await expectError(requestExtension(pragati, t.id, { requestedDeadline: day(1), reason: "x" }), "VALIDATION", "requestedDeadline");
    const ext = await requestExtension(pragati, t.id, { requestedDeadline: day(8), reason: "Portal down" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).deadline.toISOString().slice(0, 10)).toBe(day(3));
    await expectError(decideExtension(pragati, ext.id, { decision: "APPROVE" }), "FORBIDDEN");
    await Promise.allSettled([decideExtension(harsh, ext.id, { decision: "APPROVE" }), decideExtension(harsh, ext.id, { decision: "APPROVE" })]);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.deadline.toISOString().slice(0, 10)).toBe(day(8));
    expect(row.originalDeadline.toISOString().slice(0, 10)).toBe(day(3));
    expect(row.extensionsCount).toBe(1);
  });

  it("QA-019 rejection leaves deadline and counters unchanged", async () => {
    const { dilip, pragati } = await actors();
    const t = await mkTask(pragati);
    const ext = await requestExtension(pragati, t.id, { requestedDeadline: day(8), reason: "Portal down" });
    await decideExtension(dilip, ext.id, { decision: "REJECT", reason: "Use backup portal" });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.deadline.toISOString().slice(0, 10)).toBe(day(3));
    expect(row.extensionsCount).toBe(0);
  });

  it("nobody approves their own extension, including admins", async () => {
    const { harsh, dilip } = await actors();
    const t = await mkTask(harsh);
    const ext = await requestExtension(harsh, t.id, { requestedDeadline: day(9), reason: "Waiting on finance" });
    await expectError(decideExtension(harsh, ext.id, { decision: "APPROVE" }), "FORBIDDEN");
    await decideExtension(dilip, ext.id, { decision: "APPROVE" });
  });

  it("QA-020/QA-021 waiver self-approval blocked; independent approval offsets one penalty", async () => {
    const { harsh, dilip, pragati } = await actors();
    const t = await mkTask(harsh);
    const ext = await requestExtension(harsh, t.id, { requestedDeadline: day(9), reason: "Vendor delay" });
    await decideExtension(dilip, ext.id, { decision: "APPROVE" });
    const w = await requestWaiver(harsh, t.id, { extensionId: ext.id, reason: "External vendor outage" });
    await expectError(decideWaiver(harsh, w.id, { decision: "APPROVE" }), "FORBIDDEN");
    await expectError(decideWaiver(pragati, w.id, { decision: "APPROVE" }), "FORBIDDEN");
    await decideWaiver(dilip, w.id, { decision: "APPROVE" });
    await expectError(decideWaiver(dilip, w.id, { decision: "APPROVE" }), "CONFLICT");
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect([row.extensionsCount, row.waivedExtensionsCount]).toEqual([1, 1]);
    const { rows } = await computeMonth(monthKey(todayBiz()));
    expect(rows.find((r) => r.userId === harsh.id)!.disciplinePts).toBe(15);
  });

  it("QA-045 extension and waiver raised together are two separate decisions; counters increment once each", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(pragati);
    const ext = await requestExtension(pragati, t.id, { requestedDeadline: day(6), reason: "Marketplace API down", waiverReason: "Platform outage" });
    await expect(decideExtension(harsh, ext.id, { decision: "APPROVE_WITH_WAIVER" as never })).rejects.toThrow();
    await decideExtension(harsh, ext.id, { decision: "APPROVE", reason: "Platform outage" });
    let row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect([row.extensionsCount, row.waivedExtensionsCount]).toEqual([1, 0]);
    const w = await prisma.waiverRequest.findFirstOrThrow({ where: { extensionId: ext.id } });
    expect(w.status).toBe("PENDING");
    await decideWaiver(harsh, w.id, { decision: "APPROVE" });
    row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect([row.extensionsCount, row.waivedExtensionsCount]).toEqual([1, 1]);
    const types = (await prisma.auditEvent.findMany({ where: { recordId: t.id } })).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(["EXTENSION_APPROVED", "WAIVER_APPROVED", "WAIVER_REQUESTED"]));
  });

  it("unwaived extension costs 2 discipline points", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(pragati);
    const ext = await requestExtension(pragati, t.id, { requestedDeadline: day(6), reason: "Late inputs" });
    await decideExtension(harsh, ext.id, { decision: "APPROVE" });
    const { rows } = await computeMonth(monthKey(todayBiz()));
    expect(rows.find((r) => r.userId === pragati.id)!.disciplinePts).toBe(13);
  });
});

describe("cancellation requests", () => {
  it("member requests drop; admin approval drops with reason trail", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(pragati);
    const c = await requestCancellation(pragati, t.id, { kind: "DROP", reason: "Duplicate of PRG task" });
    await expectError(decideCancellation(pragati, c.id, { decision: "APPROVE" }), "FORBIDDEN");
    await decideCancellation(harsh, c.id, { decision: "APPROVE" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DROPPED");
  });
});
