import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { softDelete, restore, hardDelete, listBin } from "@/domain/deletion";
import { listTasks, changeStatus, getTaskDetail } from "@/domain/tasks";
import { kpis, reconcile } from "@/domain/metrics";
import { triggerEscalation, resolveEscalation, respondEscalation, escalationsView } from "@/domain/escalation";
import { createSubtask, changeSubtaskStatus, updateSubtask } from "@/domain/subtasks";
import { createProject, changeProjectStatus, projectRollups } from "@/domain/projects";
import { computeMonth } from "@/domain/scorecard";
import { updateTask } from "@/domain/tasks";
import { monthKey, todayBiz } from "@/lib/dates";
import { actors, backdate, day, expectError, mkTask, version } from "./helpers";

describe("bin & restore (§13, §38)", () => {
  it("QA-025/QA-026/QA-066 soft delete hides, keeps row & history; restore brings it back", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(harsh, { ownerId: pragati.id });
    await expectError(softDelete(pragati, t.id, { reason: "x" }), "FORBIDDEN");
    await expectError(softDelete(harsh, t.id, {}), "VALIDATION", "reason");
    await softDelete(harsh, t.id, { reason: "Duplicate" });
    expect(await listTasks(harsh, {})).toHaveLength(0);
    expect((await kpis(harsh)).inProgress).toBe(0);
    expect((await listBin(harsh)).rows.map((b) => b.id)).toEqual([t.id]);
    await expectError(listBin(pragati), "FORBIDDEN");
    const r = await restore(harsh, t.id, { reason: "Not a duplicate after all" });
    expect(r.task.softDeleted).toBe(false);
    expect(r.task.id).toBe(t.id);
    const types = (await prisma.auditEvent.findMany({ where: { recordId: t.id }, orderBy: { seq: "asc" } })).map((e) => e.eventType);
    expect(types).toEqual(["TASK_CREATED", "TASK_SOFT_DELETED", "TASK_RESTORED"]);
  });

  it("QA-067 purge: Admin only (denials audited), binned first, typed ID; removes workflow rows, keeps audit", async () => {
    const { harsh, dilip, pragati } = await actors();
    const a = await mkTask(harsh);
    await createSubtask(harsh, a.id, { title: "Finance clearance" });
    await softDelete(harsh, a.id, { reason: "cleanup" });
    await expectError(hardDelete(dilip, a.id, { confirmId: a.id, reason: "x" }), "FORBIDDEN");
    expect(await prisma.auditEvent.count({ where: { recordId: a.id, eventType: "TASK_PURGE_DENIED", result: "REJECTED" } })).toBe(1);
    await hardDelete(harsh, a.id, { confirmId: a.id, reason: "purge" });
    expect(await prisma.subtask.count({ where: { taskId: a.id } })).toBe(0);
    const b = await mkTask(pragati);
    await expectError(hardDelete(harsh, b.id, { confirmId: b.id, reason: "purge", backupReference: "snap" }), "BLOCKED");
    await softDelete(harsh, b.id, { reason: "test data" });
    await expectError(hardDelete(harsh, b.id, { confirmId: "wrong", reason: "purge", backupReference: "snap" }), "VALIDATION", "confirmId");
    await hardDelete(harsh, b.id, { confirmId: b.id, reason: "Test record", backupReference: "snap-2026-11-12" });
    expect(await prisma.task.findUnique({ where: { id: b.id } })).toBeNull();
    expect(await prisma.auditEvent.count({ where: { recordId: b.id, eventType: "TASK_HARD_DELETED" } })).toBe(1);
  });

  it("QA-050 exclusion gate: QA/test prefixes and binned tasks drop out of KPIs", async () => {
    const { harsh } = await actors();
    await mkTask(harsh, { name: "QA - smoke task" });
    await mkTask(harsh, { name: "test: ignore" });
    await mkTask(harsh, { name: "Quality audit of Nykaa listings" });
    await mkTask(harsh, { name: "Testimonials refresh" });
    expect((await kpis(harsh)).inProgress).toBe(2);
    expect((await reconcile()).matches).toBe(true);
  });
});

describe("audit integrity (§16.3)", () => {
  it("audit rows cannot be updated or deleted", async () => {
    const { harsh } = await actors();
    await mkTask(harsh);
    await expect(prisma.auditEvent.updateMany({ data: { actorName: "x" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe("escalations (brief §7)", () => {
  it("raiser picks the level; escalation owner resolves; task status is untouched", async () => {
    const { dilip, pragati, ritesh } = await actors();
    const t = await mkTask(pragati);
    await expectError(triggerEscalation(pragati, t.id, { reason: "x" }), "VALIDATION", "level");
    await expectError(triggerEscalation(pragati, t.id, { level: "L2" }), "VALIDATION", "reason");
    const { escalationId, level, assignee } = await triggerEscalation(pragati, t.id, { level: "L1", reason: "Finance hasn't cleared credit note" });
    expect(level).toBe("L1");
    expect(assignee.id).toBe(ritesh.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).escalationRequired).toBe(true);
    expect((await escalationsView(dilip, {})).rows.map((r) => r.task.id)).toEqual([t.id]);
    expect((await escalationsView(ritesh, {})).rows.map((r) => r.task.id)).toEqual([t.id]);
    await expectError(resolveEscalation(pragati, escalationId, { remarks: "done" }), "FORBIDDEN");
    await resolveEscalation(ritesh, escalationId, { remarks: "Finance cleared" });
    expect((await escalationsView(dilip, {})).rows).toHaveLength(0);
    expect((await escalationsView(dilip, { resolution: "resolved" })).rows[0].resolutionRemarks).toBe("Finance cleared");
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.escalationRequired).toBe(false);
    expect(after.status).toBe("NOT_STARTED");
  });

  it("respond records an update without changing level", async () => {
    const { pragati } = await actors();
    const t = await mkTask(pragati);
    const { escalationId } = await triggerEscalation(pragati, t.id, { level: "L2", reason: "blocked" });
    await respondEscalation(pragati, escalationId, { note: "Chased finance, ETA tomorrow" });
    expect((await prisma.escalation.findUniqueOrThrow({ where: { id: escalationId } })).level).toBe("L2");
  });
});

describe("subtasks & dependency verification (§25, §37)", () => {
  it("QA-064 independent subtask owner: notified, limited edit rights, task visible", async () => {
    const { pragati, ritesh } = await actors();
    const t = await mkTask(pragati);
    const s = await createSubtask(pragati, t.id, { title: "Courier pickup confirmation", ownerId: ritesh.id, depType: "E" });
    expect(s.id).toBe(`${t.id}-S01`);
    expect(await prisma.inAppNotification.count({ where: { eventType: "SUBTASK_ASSIGNED", userId: ritesh.id } })).toBe(1);
    expect((await getTaskDetail(ritesh, t.id)).task.id).toBe(t.id);
    await expectError(updateTask(ritesh, t.id, { expectedVersion: await version(t.id), patch: { name: "nope" } }), "FORBIDDEN");
    await expectError(updateSubtask(ritesh, s.id, { expectedVersion: s.version, patch: { title: "nope" } }), "FORBIDDEN");
    await updateSubtask(ritesh, s.id, { expectedVersion: s.version, patch: { outputLink: "https://example.com/pod.pdf" } });
  });

  it("QA-065 parent completion requires subtasks; never auto-completes", async () => {
    const { harsh, pragati } = await actors();
    const t = await mkTask(pragati);
    const s = await createSubtask(pragati, t.id, { title: "Finance clearance", depType: "I" });
    await expectError(changeStatus(pragati, t.id, { to: "COMPLETED", expectedVersion: await version(t.id) }), "BLOCKED");
    await expectError(changeStatus(pragati, t.id, { to: "COMPLETED", expectedVersion: await version(t.id), overrideIncompleteSubtasks: true, reason: "x" }), "FORBIDDEN");
    await changeSubtaskStatus(pragati, s.id, { to: "COMPLETED", expectedVersion: s.version });
    const detail = await getTaskDetail(pragati, t.id);
    expect(detail.task.status).toBe("NOT_STARTED");
    expect(detail.task.subtasks.readyForCompletion).toBe(true);
    await changeStatus(pragati, t.id, { to: "COMPLETED", expectedVersion: await version(t.id) });
    const t2 = await mkTask(pragati);
    await createSubtask(pragati, t2.id, { title: "open one" });
    await changeStatus(harsh, t2.id, { to: "COMPLETED", expectedVersion: await version(t2.id), overrideIncompleteSubtasks: true, reason: "Delivered via alternate path" });
  });

  it("QA-040/041/042 subtask evidence supersedes task tag; fallback; null gets nothing", async () => {
    const { pragati, ritesh, suraj } = await actors();
    const a = await mkTask(pragati, { pocType: "I", pendingFrom: "Finance team" });
    const s1 = await createSubtask(pragati, a.id, { title: "Brand team assets", depType: "WB" });
    const s2 = await createSubtask(pragati, a.id, { title: "Agency creatives", depType: "E" });
    for (const s of [s1, s2]) await changeSubtaskStatus(pragati, s.id, { to: "COMPLETED", expectedVersion: s.version });
    await changeStatus(pragati, a.id, { to: "COMPLETED", expectedVersion: await version(a.id) });
    const b = await mkTask(ritesh, { pocType: "E", pendingFrom: "Courier partner" });
    await changeStatus(ritesh, b.id, { to: "COMPLETED", expectedVersion: b.version });
    const c = await mkTask(suraj);
    await changeStatus(suraj, c.id, { to: "COMPLETED", expectedVersion: c.version });
    const { rows } = await computeMonth(monthKey(todayBiz()));
    const P = rows.find((r) => r.userId === pragati.id)!;
    expect([P.depI, P.depWB, P.depE, P.dependencyPts]).toEqual([0, 1, 1, 8.5]);
    expect(P.evidence.dependencySources.every((d) => d.source === "SUBTASK")).toBe(true);
    const R = rows.find((r) => r.userId === ritesh.id)!;
    expect([R.depE, R.dependencyPts]).toEqual([1, 5]);
    expect(rows.find((r) => r.userId === suraj.id)!.dependencyPts).toBe(0);
  });
});

describe("projects (§35)", () => {
  it("QA-059/QA-060 roll-ups across owners; closure blocked/overridden without completing tasks", async () => {
    const { harsh, pragati, ritesh } = await actors();
    const p = await createProject(harsh, { name: "Q4 Growth", ownerId: harsh.id });
    const a = await mkTask(harsh, { ownerId: pragati.id, projectId: p.id });
    const b = await mkTask(harsh, { ownerId: ritesh.id, projectId: p.id, channelId: (await prisma.channel.findUniqueOrThrow({ where: { name: "Blinkit" } })).id });
    await mkTask(harsh, { name: "QA project check", projectId: p.id });
    await changeStatus(pragati, a.id, { to: "COMPLETED", expectedVersion: a.version });
    const r = (await projectRollups(harsh)).find((x) => x.id === p.id)!;
    expect([r.total, r.completed, r.active, r.taskCompletionPct]).toEqual([2, 1, 1, 50]);
    await expectError(changeProjectStatus(harsh, p.id, { to: "COMPLETED" }), "BLOCKED");
    await expectError(changeProjectStatus(harsh, p.id, { to: "COMPLETED", overrideOpenTasks: true }), "VALIDATION", "reason");
    await changeProjectStatus(harsh, p.id, { to: "COMPLETED", overrideOpenTasks: true, reason: "Season over" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("NOT_STARTED");
    await expectError(mkTask(harsh, { projectId: p.id }), "VALIDATION", "projectId");
  });

  it("QA-031 UI-only reads leave the scorecard unchanged", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh);
    await changeStatus(harsh, t.id, { to: "COMPLETED", expectedVersion: t.version });
    const before = await computeMonth(monthKey(todayBiz()));
    await listTasks(harsh, {}); await kpis(harsh); await getTaskDetail(harsh, t.id); await projectRollups(harsh);
    expect(await computeMonth(monthKey(todayBiz()))).toEqual(before);
  });

  it("backdated completion counts in completion month only", async () => {
    const { harsh } = await actors();
    const t = await mkTask(harsh);
    await changeStatus(harsh, t.id, { to: "COMPLETED", expectedVersion: t.version });
    await backdate(t.id, { completedAt: new Date(Date.UTC(2026, 0, 15, 6)) });
    expect((await computeMonth("2026-01")).rows.find((r) => r.userId === harsh.id)!.completedOnTime + (await computeMonth("2026-01")).rows.find((r) => r.userId === harsh.id)!.completedLate).toBe(1);
    expect((await computeMonth(monthKey(todayBiz()))).rows.find((r) => r.userId === harsh.id)!.evidence.completedTasks).toHaveLength(0);
  });
});
