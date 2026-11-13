import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createTask, updateTask, changeStatus, listTasks, getTaskDetail } from "@/domain/tasks";
import { actors, backdate, channel, day, expectError, mkTask, version } from "./helpers";

describe("task creation (§18.1)", () => {
  it("QA-001 creates one task with mandatory fields only; optional fields blank; system fields set", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh);
    expect(t.id).toMatch(/^HSH-\d{6}-001$/);
    expect(t.status).toBe("NOT_STARTED");
    expect(t.assignedDate).toBe(day(0));
    expect(t.project).toBeNull();
    expect(t.workstream).toBeNull();
    expect(t.outputLink).toBeNull();
    expect(t.pocType).toBeNull();
    expect(t.escalationLevel).toBe("L0");
    expect(t.slaPolicyId).toBe("SLA-STD");
    expect(await prisma.task.count()).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "TASK_CREATED" } })).toBe(1);
  });

  it.each([
    ["QA-002", "name", { name: "  " }],
    ["QA-003", "channelId", { channelId: "" }],
    ["QA-004", "ownerId", { ownerId: "" }],
    ["QA-005", "priority", { priority: undefined }],
    ["QA-006", "deadline", { deadline: "" }],
  ])("%s blocks save when %s is blank, with a field-level error", async (_id, field, over) => {
    const { harsh } = await actors();
    const base = { name: "Valid name", channelId: await channel(), ownerId: harsh.id, priority: 2, deadline: day(2) };
    await expectError(createTask(harsh, { ...base, ...over }), "VALIDATION", field);
    expect(await prisma.task.count()).toBe(0);
  });

  it("QA-007 allows blank workstream, project, subtask and output link", async () => {
    const { pragati } = await actors();
    const t = await mkTask(pragati, { workstreamId: null, projectId: null, outputLink: "" });
    expect(t.id).toBeTruthy();
  });

  it("QA-008 rejects invalid dropdown values and stores nothing", async () => {
    const { harsh } = await actors();
    const err = await expectError(createTask(harsh, { name: "Valid", channelId: "nope", ownerId: harsh.id, priority: "P11", deadline: day(1), pocType: "X", pendingFrom: "Someone" }), "VALIDATION");
    expect(Object.keys(err.fields!)).toEqual(expect.arrayContaining(["channelId", "priority", "pocType"]));
    expect(await prisma.task.count()).toBe(0);
  });

  it("rejects deadline before assigned date and non-http links", async () => {
    const { harsh } = await actors();
    await expectError(mkTask(harsh, { deadline: day(-1) }), "VALIDATION", "deadline");
    await expectError(mkTask(harsh, { outputLink: "javascript:alert(1)" }), "VALIDATION", "outputLink");
  });

  it("QA-009/QA-062 retries with the same idempotency key return the original task", async () => {
    const { harsh } = await actors();
    const input = { name: "Retry me", channelId: await channel(), ownerId: harsh.id, priority: 2, deadline: day(2) };
    const [a, b] = await Promise.all([createTask(harsh, input, "req-1"), createTask(harsh, input, "req-1")]);
    expect(a.result.task.id).toBe(b.result.task.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await prisma.task.count()).toBe(1);
  });

  it("QA-061 concurrent creates get unique IDs", async () => {
    const { harsh } = await actors();
    const ch = await channel();
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => createTask(harsh, { name: `Parallel ${i}`, channelId: ch, ownerId: harsh.id, priority: 4, deadline: day(1) })));
    const ids = all.map((r) => r.result.task.id);
    expect(new Set(ids).size).toBe(12);
  });

  it("QA-010 derived fields: aging, TAT and timeliness", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh);
    await backdate(t.id, { assignedDate: day(-5), deadline: day(-1) });
    let [dto] = await listTasks(harsh, {});
    expect(dto.agingDays).toBe(5);
    expect(dto.timeliness).toBe("OVERDUE");
    expect(dto.tatDays).toBeNull();
    await changeStatus(harsh, t.id, { to: "COMPLETED", expectedVersion: await version(t.id) });
    dto = (await listTasks(harsh, { scope: "completed" }))[0];
    expect(dto.timeliness).toBe("LATE");
    expect(dto.tatDays).toBe(5);
  });

  it("completing on the deadline day is on time", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh, { deadline: day(0) });
    const done = await changeStatus(harsh, t.id, { to: "COMPLETED", expectedVersion: t.version });
    expect(done.timeliness).toBe("ON_TIME");
  });

  it("member P0 requires justification; admin does not", async () => {
    const { pragati, harsh } = await actors();
    await expectError(mkTask(pragati, { priority: 0 }), "VALIDATION", "p0Justification");
    const ok = await mkTask(pragati, { priority: 0, p0Justification: "Amazon listing suppressed — revenue loss" });
    expect(ok.priority).toBe(0);
    expect(await prisma.auditEvent.count({ where: { eventType: "P0_JUSTIFIED" } })).toBe(1);
    expect((await mkTask(harsh, { priority: 0 })).priority).toBe(0);
  });

  it("member creating for a peer keeps ownership until the peer accepts (no silent assignment)", async () => {
    const { pragati, ritesh } = await actors();
    const { result } = await createTask(pragati, { name: "Peer task", channelId: await channel(), ownerId: ritesh.id, priority: 3, deadline: day(2) });
    expect(result.peerTransferPending).toBe(true);
    expect(result.task.owner.id).toBe(pragati.id);
    expect(await prisma.transfer.count({ where: { status: "PENDING", toUserId: ritesh.id } })).toBe(1);
  });
});

describe("editing & lifecycle (§18.2)", () => {
  it("QA-011 system-owned fields are rejected", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh);
    await expectError(updateTask(harsh, t.id, { expectedVersion: t.version, patch: { status: "COMPLETED" } }), "VALIDATION", "status");
    await expectError(updateTask(harsh, t.id, { expectedVersion: t.version, patch: { tatDays: 1 } }), "VALIDATION", "tatDays");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("NOT_STARTED");
  });

  it("members cannot edit others' tasks or change deadlines directly", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    await expectError(updateTask(ritesh, t.id, { expectedVersion: t.version, patch: { name: "Hijack" } }), "NOT_FOUND");
    await expectError(updateTask(pragati, t.id, { expectedVersion: t.version, patch: { deadline: day(9) }, reason: "x" }), "FORBIDDEN");
    const u = await updateTask(pragati, t.id, { expectedVersion: t.version, patch: { remarks: "Waiting on Amazon SPOC" } });
    expect(u.remarks).toBe("Waiting on Amazon SPOC");
  });

  it("admin deadline override needs a reason, keeps the original deadline and does not count as an extension", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh);
    await expectError(updateTask(harsh, t.id, { expectedVersion: t.version, patch: { deadline: day(10) } }), "VALIDATION", "deadline");
    const u = await updateTask(harsh, t.id, { expectedVersion: t.version, patch: { deadline: day(10) }, reason: "Scope expanded" });
    expect(u.deadline).toBe(day(10));
    expect(u.originalDeadline).toBe(day(3));
    expect(u.extensionsCount).toBe(0);
  });

  it("QA-027 stale writes are rejected with the latest record", async () => {
    const { harsh, dilip } = await actors();
    const t = await mkTask(harsh);
    await updateTask(harsh, t.id, { expectedVersion: t.version, patch: { remarks: "first" } });
    const err = await expectError(updateTask(dilip, t.id, { expectedVersion: t.version, patch: { remarks: "second" } }), "STALE");
    expect((err.details as { remarks: string }).remarks).toBe("first");
  });

  it("QA-022 completion records actor/time; QA-023 reopen keeps the completion event", async () => {
    const { pragati } = await actors();
    const t = await mkTask(pragati);
    await changeStatus(pragati, t.id, { to: "IN_PROGRESS", expectedVersion: t.version });
    const done = await changeStatus(pragati, t.id, { to: "COMPLETED", expectedVersion: await version(t.id) });
    expect(done.completedAt).toBeTruthy();
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.completedById).toBe(pragati.id);
    await expectError(changeStatus(pragati, t.id, { to: "IN_PROGRESS", expectedVersion: row.version }), "VALIDATION", "reason");
    const reopened = await changeStatus(pragati, t.id, { to: "IN_PROGRESS", expectedVersion: row.version, reason: "Client rejected" });
    expect(reopened.completedAt).toBeNull();
    const events = await prisma.auditEvent.findMany({ where: { recordId: t.id }, orderBy: { seq: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["TASK_COMPLETED", "TASK_REOPENED"]));
  });

  it("QA-024 dropping requires a reason and authority; dropped tasks leave active workload", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    await expectError(changeStatus(pragati, t.id, { to: "DROPPED", expectedVersion: t.version, reason: "no" }), "FORBIDDEN");
    await expectError(changeStatus(harsh, t.id, { to: "DROPPED", expectedVersion: t.version }), "VALIDATION", "reason");
    await changeStatus(harsh, t.id, { to: "DROPPED", expectedVersion: t.version, reason: "Channel paused" });
    expect(await listTasks(harsh, {})).toHaveLength(0);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).droppedReason).toBe("Channel paused");
  });

  it("rejects transitions outside the matrix", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh);
    await changeStatus(harsh, t.id, { to: "COMPLETED", expectedVersion: t.version });
    await expectError(changeStatus(harsh, t.id, { to: "ON_HOLD", expectedVersion: await version(t.id) }), "INVALID_TRANSITION");
  });

  it("QA-049 raw metadata is visible to admin only", async () => {
    const { harsh, dilip, pragati } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    expect((await getTaskDetail(harsh, t.id)).rawMetadata).toBeTruthy();
    expect((await getTaskDetail(dilip, t.id)).rawMetadata).toBeUndefined();
    expect((await getTaskDetail(pragati, t.id)).rawMetadata).toBeUndefined();
  });
});
