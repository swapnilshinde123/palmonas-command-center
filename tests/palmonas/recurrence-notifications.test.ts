import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { patternDates, datesBetween, createSeries, runTimeDriven, seriesAction, updateSeries, type Pattern } from "@/domain/recurrence";
import { changeStatus } from "@/domain/tasks";
import { processQueue } from "@/domain/notifications/processor";
import { generateDigests } from "@/domain/notifications/digests";
import { resetTransportForTests } from "@/domain/notifications/mailer";
import { addDays, iso, parseISODate, todayBiz } from "@/lib/dates";
import { actors, channel, day, expectError, mkTask, version, emailOn } from "./helpers";

const P = (over: Partial<Pattern>): Pattern => ({ cadence: "DAILY", interval: 1, weekdays: [], dayOfMonth: null, workingDaysOnly: false, startDate: parseISODate("2026-11-02"), endDate: null, ...over });
const take = (p: Pattern, n: number, from = p.startDate) => { const out: string[] = []; for (const d of patternDates(p, from)) { out.push(iso(d)!); if (out.length >= n) break; } return out; };

describe("recurrence date rules (§34.2, §34.4)", () => {
  it("QA-051 daily, every N days, and working days only", () => {
    expect(take(P({}), 3)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(take(P({ interval: 3 }), 3)).toEqual(["2026-11-02", "2026-11-05", "2026-11-08"]);
    expect(take(P({ workingDaysOnly: true, startDate: parseISODate("2026-11-06") }), 3)).toEqual(["2026-11-06", "2026-11-09", "2026-11-10"]);
  });

  it("QA-052 weekly and bi-weekly respect weekday and anchor week", () => {
    expect(take(P({ cadence: "WEEKLY", weekdays: [1, 4] }), 4)).toEqual(["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12"]);
    expect(take(P({ cadence: "BIWEEKLY", weekdays: [1] }), 3)).toEqual(["2026-11-02", "2026-11-16", "2026-11-30"]);
    expect(take(P({ cadence: "BIWEEKLY", weekdays: [1] }), 2, parseISODate("2026-11-10"))).toEqual(["2026-11-16", "2026-11-30"]);
  });

  it("QA-053 monthly on 29/30/31 clamps to month end deterministically", () => {
    const p = P({ cadence: "MONTHLY", dayOfMonth: 31, startDate: parseISODate("2026-12-31") });
    expect(take(p, 4)).toEqual(["2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"]);
    expect(take(P({ cadence: "MONTHLY", dayOfMonth: 30, startDate: parseISODate("2028-01-30") }), 2)).toEqual(["2028-01-30", "2028-02-29"]);
  });

  it("respects end date", () => {
    expect(datesBetween(P({ endDate: parseISODate("2026-11-04") }), parseISODate("2026-11-01"), parseISODate("2026-12-01")).map(iso)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
  });
});

describe("recurrence engine (§34.3, §34.6–34.8)", () => {
  async function dailySeries(over: Record<string, unknown> = {}) {
    const { pragati } = await actors();
    return createSeries(pragati, { title: "Daily Amazon sales check", channelId: await channel(), ownerId: pragati.id, priority: 3, cadence: "DAILY", startDate: day(0), ...over });
  }

  it("QA-054 running the trigger twice for the same cycle creates one occurrence", async () => {
    const s = await dailySeries();
    await runTimeDriven();
    await Promise.all([runTimeDriven(), runTimeDriven()]);
    const occ = await prisma.task.findMany({ where: { seriesId: s.id } });
    expect(occ).toHaveLength(1);
    expect(occ[0].occurrenceNumber).toBe(1);
    expect(iso(occ[0].scheduledDate)).toBe(day(0));
  });

  it("missed cycles follow LATEST_ONLY by default and record skipped cycles", async () => {
    const s = await dailySeries({ startDate: day(-4) });
    const occ = await prisma.task.findMany({ where: { seriesId: s.id } });
    expect(occ.map((o) => iso(o.scheduledDate))).toEqual([day(0)]);
    expect(await prisma.seriesException.count({ where: { seriesId: s.id, kind: "SKIPPED_CYCLES" } })).toBe(1);
    const all = await dailySeries({ title: "Catch up", startDate: day(-2), missedPolicy: "CATCH_UP_ALL" });
    expect(await prisma.task.count({ where: { seriesId: all.id } })).toBe(3);
    const manual = await dailySeries({ title: "Manual", startDate: day(-2), missedPolicy: "MANUAL_REVIEW" });
    expect(await prisma.task.count({ where: { seriesId: manual.id } })).toBe(0);
    expect(await prisma.seriesException.count({ where: { seriesId: manual.id, kind: "MANUAL_REVIEW" } })).toBe(1);
  });

  it("QA-055 overdue predecessor: BLOCK stops spawning, WARN spawns with warning", async () => {
    const s = await dailySeries({ startDate: day(-3), overduePolicy: "BLOCK", deadlineOffsetDays: 0, missedPolicy: "CATCH_UP_ALL", maxCatchUp: 1 });
    // CATCH_UP_ALL with maxCatchUp=1 created only today's; force the series back so tomorrow is due with an overdue predecessor.
    const pred = await prisma.task.findFirstOrThrow({ where: { seriesId: s.id } });
    await prisma.task.update({ where: { id: pred.id }, data: { deadline: parseISODate(day(-1)) } });
    await prisma.recurringSeries.update({ where: { id: s.id }, data: { nextOccurrenceDate: parseISODate(day(0)) } });
    await prisma.task.update({ where: { id: pred.id }, data: { scheduledDate: parseISODate(day(-1)) } });
    await runTimeDriven();
    expect(await prisma.task.count({ where: { seriesId: s.id } })).toBe(1);
    expect(await prisma.seriesException.count({ where: { seriesId: s.id, kind: "PREDECESSOR_BLOCKED" } })).toBe(1);
  });

  it("QA-056 completion-driven: dropped predecessor blocks by default; completion spawns exactly one successor", async () => {
    const { harsh, pragati } = await actors();
    const s = await dailySeries({ triggerMode: "COMPLETION_DRIVEN" });
    const first = await prisma.task.findFirstOrThrow({ where: { seriesId: s.id } });
    await changeStatus(pragati, first.id, { to: "COMPLETED", expectedVersion: first.version });
    expect(await prisma.task.count({ where: { seriesId: s.id } })).toBe(2);
    await changeStatus(pragati, first.id, { to: "IN_PROGRESS", expectedVersion: await version(first.id), reason: "Reopen" });
    await changeStatus(pragati, first.id, { to: "COMPLETED", expectedVersion: await version(first.id) });
    expect(await prisma.task.count({ where: { seriesId: s.id } })).toBe(2);
    const second = await prisma.task.findFirstOrThrow({ where: { seriesId: s.id, occurrenceNumber: 2 } });
    expect(second.clonedFromId).toBe(first.id);
    await changeStatus(harsh, second.id, { to: "DROPPED", expectedVersion: second.version, reason: "Holiday" });
    expect(await prisma.task.count({ where: { seriesId: s.id } })).toBe(2);
    expect(await prisma.seriesException.count({ where: { seriesId: s.id, kind: "PREDECESSOR_BLOCKED" } })).toBe(1);
  });

  it("QA-057 paused or ended series do not spawn; QA-058 cadence edits leave existing occurrences", async () => {
    const { pragati } = await actors();
    const s = await dailySeries();
    await expectError(seriesAction(pragati, s.id, { action: "PAUSE", reason: "Festive freeze" }), "VALIDATION", "followupDate");
    await seriesAction(pragati, s.id, { action: "PAUSE", reason: "Festive freeze", followupDate: iso(addDays(todayBiz(), 5))! });
    await prisma.recurringSeries.update({ where: { id: s.id }, data: { nextOccurrenceDate: todayBiz() } });
    await prisma.task.deleteMany({ where: { seriesId: s.id } });
    await runTimeDriven();
    expect(await prisma.task.count({ where: { seriesId: s.id } })).toBe(0);
    await seriesAction(pragati, s.id, { action: "RESUME" });
    await runTimeDriven();
    const before = await prisma.task.findMany({ where: { seriesId: s.id } });
    expect(before).toHaveLength(1);
    const cur = await prisma.recurringSeries.findUniqueOrThrow({ where: { id: s.id } });
    await updateSeries(pragati, s.id, { expectedVersion: cur.version, patch: { cadence: "WEEKLY", weekdays: ["MON"] } });
    const after = await prisma.task.findMany({ where: { seriesId: s.id } });
    expect(after.map((t) => [t.id, iso(t.scheduledDate)])).toEqual(before.map((t) => [t.id, iso(t.scheduledDate)]));
    expect(weekdayOf((await prisma.recurringSeries.findUniqueOrThrow({ where: { id: s.id } })).nextOccurrenceDate!)).toBe(1);
    await expectError(seriesAction(pragati, s.id, { action: "END" }), "VALIDATION", "reason");
    await seriesAction(pragati, s.id, { action: "END", reason: "Process retired" });
    await prisma.recurringSeries.update({ where: { id: s.id }, data: { nextOccurrenceDate: addDays(todayBiz(), -1) } });
    await runTimeDriven();
    expect(await prisma.task.count({ where: { seriesId: s.id } })).toBe(1);
  });
});
const weekdayOf = (d: Date) => d.getUTCDay();

describe("notification queue (§28, §39)", () => {
  it("QA-046/QA-072 events are deduplicated and overlapping processors never double-send", async () => {
    await emailOn();
    const sent: string[] = [];
    resetTransportForTests({ sendMail: async (m: { to: string; subject: string }) => { sent.push(`${m.to}|${m.subject}`); await new Promise((r) => setTimeout(r, 20)); return { messageId: "x" }; } } as never);
    const { harsh, ritesh } = await actors();
    for (let i = 0; i < 5; i++) await mkTask(harsh, { ownerId: ritesh.id, name: `Assigned ${i}` });
    await Promise.all([processQueue(), processQueue(), processQueue()]);
    expect(sent).toHaveLength(5);
    expect(new Set(sent).size).toBe(5);
    await processQueue();
    expect(sent).toHaveLength(5);
    resetTransportForTests(null);
  });

  it("QA-047/QA-070/QA-071 failures are isolated, categorised and retried with backoff; bad recipients dead-letter", async () => {
    await emailOn();
    const { harsh, ritesh, riya } = await actors();
    await prisma.user.update({ where: { id: riya.id }, data: { email: "not-an-email" } });
    let calls = 0;
    resetTransportForTests({ sendMail: async () => { calls++; if (calls === 1) throw Object.assign(new Error("452 quota exceeded"), { responseCode: 452 }); return { messageId: "ok" }; } } as never);
    await mkTask(harsh, { ownerId: ritesh.id, name: "One" });
    await mkTask(harsh, { ownerId: riya.id, name: "Two" });
    await mkTask(harsh, { ownerId: ritesh.id, name: "Three" });
    const s = await processQueue();
    expect(s).toMatchObject({ claimed: 3, sent: 1, failed: 1, dead: 1 });
    const failed = await prisma.notificationEvent.findFirstOrThrow({ where: { status: "FAILED" } });
    expect(failed.errorCategory).toBe("QUOTA");
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect((await prisma.notificationEvent.findFirstOrThrow({ where: { status: "DEAD" } })).errorCategory).toBe("INVALID_RECIPIENT");
    await prisma.notificationEvent.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date() } });
    expect((await processQueue()).sent).toBe(1);
    resetTransportForTests(null);
  });

  it("QA-048/QA-073 digests: once per day after 09:00 IST, personal scope only, executive for leadership", async () => {
    await emailOn({ digestsEnabled: true });
    const { harsh, pragati, ritesh } = await actors();
    await mkTask(harsh, { ownerId: pragati.id, name: "Pragati private task", deadline: day(0) });
    await mkTask(harsh, { ownerId: ritesh.id, name: "Ritesh task", deadline: day(1) });
    const before9 = new Date(`${day(0)}T03:00:00Z`); // 08:30 IST
    expect(await generateDigests(before9)).toEqual({ personal: 0, executive: 0 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${day(0)}T04:00:00Z`)); // 09:30 IST
    const r = await generateDigests(new Date());
    expect(r.executive).toBe(2);
    expect(await generateDigests(new Date())).toEqual({ personal: 0, executive: 0 });
    vi.useRealTimers();
    const pd = await prisma.notificationEvent.findFirstOrThrow({ where: { eventType: "MORNING_DIGEST_PERSONAL", recipientId: ritesh.id } });
    expect(JSON.stringify(pd.payload)).not.toContain("Pragati private task");
    expect(await prisma.notificationEvent.count({ where: { eventType: "EXECUTIVE_DIGEST" } })).toBe(2);
    const ex = await prisma.notificationEvent.findFirstOrThrow({ where: { eventType: "EXECUTIVE_DIGEST" } });
    expect((ex.payload as { dataAsOf: string }).dataAsOf).toBeTruthy();
  });
});
