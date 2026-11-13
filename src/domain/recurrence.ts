import { z } from "zod";
import type { Cadence, Prisma, RecurringSeries, DepTier } from "@prisma/client";
import { prisma, tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { log } from "@/lib/log";
import { getHolidays } from "@/lib/config";
import { addDays, addWorkingDays, daysInMonth, diffDays, iso, isWorkingDay, todayBiz, tryParseISODate, weekday } from "@/lib/dates";
import { assertCan, can, type Actor } from "./rbac";
import { audit, diff } from "./audit";
import { allocateSeriesId } from "./ids";
import { enqueue, governanceRecipients } from "./notifications/enqueue";
import type { TaskWithRefs } from "./task-core";
import { DEP_TIERS } from "./task-core";
import { insertTask } from "./tasks";

// ---------- Pure date rules (§34.2, §34.4) ----------

export interface Pattern {
  cadence: Cadence;
  interval: number;
  weekdays: number[]; // 0=Sun..6=Sat
  dayOfMonth: number | null;
  workingDaysOnly: boolean;
  startDate: Date;
  endDate: Date | null;
}

const mondayOf = (d: Date) => addDays(d, -((weekday(d) + 6) % 7));

// Yields scheduled dates >= from in order. Month-end rule: clamp to the month's last day (DEC: CLAMP).
export function* patternDates(p: Pattern, from: Date, holidays: Set<string> = new Set()): Generator<Date> {
  const lower = from > p.startDate ? from : p.startDate;
  const inRange = (d: Date) => d >= lower && (!p.endDate || d <= p.endDate);
  const past = (d: Date) => !!p.endDate && d > p.endDate;
  const step = Math.max(1, p.interval);

  if (p.cadence === "DAILY") {
    if (p.workingDaysOnly) {
      let n = 0;
      for (let d = p.startDate; !past(d); d = addDays(d, 1)) {
        if (!isWorkingDay(d, holidays)) continue;
        if (n++ % step === 0 && inRange(d)) yield d;
        if (diffDays(d, lower) > 3660) return;
      }
      return;
    }
    const skip = Math.max(0, Math.ceil(diffDays(lower, p.startDate) / step));
    for (let d = addDays(p.startDate, skip * step); !past(d); d = addDays(d, step)) if (inRange(d)) yield d;
    return;
  }
  if (p.cadence === "WEEKLY" || p.cadence === "BIWEEKLY") {
    const every = (p.cadence === "BIWEEKLY" ? 2 : 1) * step;
    const days = (p.weekdays.length ? p.weekdays : [weekday(p.startDate)]).map((w) => (w + 6) % 7).sort((a, b) => a - b);
    const anchor = mondayOf(p.startDate);
    const skipWeeks = Math.max(0, Math.floor(diffDays(mondayOf(lower), anchor) / 7 / every));
    for (let wk = addDays(anchor, skipWeeks * every * 7); ; wk = addDays(wk, every * 7)) {
      for (const off of days) {
        const d = addDays(wk, off);
        if (past(d)) return;
        if (inRange(d) && (!p.workingDaysOnly || isWorkingDay(d, holidays))) yield d;
      }
      if (diffDays(wk, lower) > 3660) return;
    }
  }
  // MONTHLY
  const dom = p.dayOfMonth ?? p.startDate.getUTCDate();
  let y = p.startDate.getUTCFullYear();
  let m = p.startDate.getUTCMonth();
  for (let i = 0; i < 1200; i++, m += step) {
    while (m > 11) { m -= 12; y++; }
    const d = new Date(Date.UTC(y, m, Math.min(dom, daysInMonth(y, m))));
    if (past(d)) return;
    if (inRange(d)) yield d;
  }
}

export function firstDateOnOrAfter(p: Pattern, from: Date, holidays?: Set<string>): Date | null {
  for (const d of patternDates(p, from, holidays)) return d;
  return null;
}

export function datesBetween(p: Pattern, from: Date, to: Date, holidays?: Set<string>, cap = 400): Date[] {
  const out: Date[] = [];
  for (const d of patternDates(p, from, holidays)) {
    if (d > to || out.length >= cap) break;
    out.push(d);
  }
  return out;
}

// PREDECESSOR_COMPLETION anchor: restart the pattern from the day after completion.
export function nextAnchoredOnCompletion(p: Pattern, completedOn: Date, holidays?: Set<string>) {
  if (p.cadence === "DAILY" && !p.workingDaysOnly) return addDays(completedOn, Math.max(1, p.interval));
  return firstDateOnOrAfter({ ...p, startDate: addDays(completedOn, 1) }, addDays(completedOn, 1), holidays);
}

const asPattern = (s: RecurringSeries): Pattern => ({ cadence: s.cadence, interval: s.interval, weekdays: s.weekdays, dayOfMonth: s.dayOfMonth, workingDaysOnly: s.workingDaysOnly, startDate: s.startDate, endDate: s.endDate });

// ---------- Spawning ----------

async function exception(tx: Tx, seriesId: string, kind: string, detail: string, date: Date | null = null) {
  const dup = await tx.seriesException.findFirst({ where: { seriesId, kind, date, resolved: false } });
  if (dup) return;
  await tx.seriesException.create({ data: { seriesId, kind, detail, date } });
  await audit(tx, { recordId: seriesId, entityType: "SERIES", eventType: `SERIES_${kind}`, actor: null, reason: detail });
  await enqueue(tx, { eventType: "SERIES_EXCEPTION", transitionId: `${seriesId}:${kind}:${iso(date) ?? "-"}`, recipientIds: await governanceRecipients(tx, ["ADMIN"]), subject: `Recurring series ${seriesId}: ${kind}`, payload: { seriesId, kind, detail } });
}

async function spawnOccurrence(tx: Tx, s: RecurringSeries, scheduled: Date, assigned: Date, predecessorId: string | null, holidays: Set<string>) {
  // DB unique (seriesId, scheduledDate) is the final idempotency guard (§34.6).
  if (await tx.task.findFirst({ where: { seriesId: s.id, scheduledDate: scheduled }, select: { id: true } })) return null;
  if (s.maxOccurrences && s.occurrenceCount >= s.maxOccurrences) return null;
  const channel = await tx.channel.findUniqueOrThrow({ where: { id: s.channelId } });
  const owner = await tx.user.findUnique({ where: { id: s.ownerId } });
  if (owner?.status !== "ACTIVE") throw new Error(`Series owner ${s.ownerId} is inactive`);
  const deadline = s.workingDaysOnly ? addWorkingDays(scheduled, s.deadlineOffsetDays, holidays) : addDays(scheduled, s.deadlineOffsetDays);
  const occurrenceNumber = s.occurrenceCount + 1;
  const task = await insertTask(tx, null, {
    name: s.title, channelId: s.channelId, channelName: channel.name, ownerId: s.ownerId, priority: s.priority,
    deadline: deadline < assigned ? assigned : deadline, pocType: null, pocId: null, customPoc: false, workstreamId: null, projectId: s.projectId,
    description: s.description, outputLink: null, pendingFrom: null, followupDate: null,
  }, { seriesId: s.id, occurrenceNumber, scheduledDate: scheduled, clonedFromId: predecessorId, assignedDate: assigned, idNamespace: owner!.code });
  await tx.recurringSeries.update({ where: { id: s.id }, data: { occurrenceCount: { increment: 1 } } });
  s.occurrenceCount = occurrenceNumber;
  await enqueue(tx, { eventType: "TASK_ASSIGNED", transitionId: `occ-${task.id}`, taskId: task.id, recipientIds: [s.ownerId], subject: `Recurring task: ${s.title}`, payload: { taskId: task.id, seriesId: s.id, scheduled: iso(scheduled) } });
  return task;
}

// Time-driven engine (§34.3A). Safe to run concurrently: series rows are claimed with SKIP LOCKED.
export async function runTimeDriven(now = new Date()) {
  const today = todayBiz(now);
  const holidays = await getHolidays();
  const ids = await prisma.recurringSeries.findMany({ where: { status: "ACTIVE", triggerMode: "TIME_DRIVEN", nextOccurrenceDate: { lte: today } }, select: { id: true } });
  let created = 0;
  for (const { id } of ids) {
    try {
      created += await runTx(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "RecurringSeries" WHERE "id" = ${id} FOR UPDATE SKIP LOCKED`;
        if (!locked.length) return 0;
        const s = await tx.recurringSeries.findUniqueOrThrow({ where: { id } });
        if (s.status !== "ACTIVE" || !s.nextOccurrenceDate || s.nextOccurrenceDate > today) return 0;
        const skips = new Set((await tx.seriesSkip.findMany({ where: { seriesId: id } })).map((k) => iso(k.date)));
        const due = datesBetween(asPattern(s), s.nextOccurrenceDate, today, holidays).filter((d) => !skips.has(iso(d)));
        const last = due.at(-1);
        const after = last ? addDays(last, 1) : addDays(today, 1);
        const advance = async () => {
          const nxt = firstDateOnOrAfter(asPattern(s), after, holidays);
          const ended = !nxt || (s.maxOccurrences != null && s.occurrenceCount >= s.maxOccurrences);
          await tx.recurringSeries.update({ where: { id }, data: { nextOccurrenceDate: nxt, status: ended ? "ENDED" : "ACTIVE" } });
        };
        if (!due.length) { await advance(); return 0; }

        const pred = await tx.task.findFirst({ where: { seriesId: id }, orderBy: { scheduledDate: "desc" } });
        if (pred && pred.status === "DROPPED" && s.droppedPolicy !== "ALLOW") {
          await exception(tx, id, "PREDECESSOR_BLOCKED", `Predecessor ${pred.id} was dropped.`, last!);
          if (s.droppedPolicy === "BLOCK") return 0;
        }
        if (pred && ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"].includes(pred.status) && today > pred.deadline && s.overduePolicy !== "ALLOW") {
          await exception(tx, id, s.overduePolicy === "BLOCK" ? "PREDECESSOR_BLOCKED" : "OVERLAP_WARNING", `Predecessor ${pred.id} is overdue.`, last!);
          if (s.overduePolicy === "BLOCK") return 0;
        }

        let toCreate: Date[] = due;
        if (due.length > 1) {
          if (s.missedPolicy === "MANUAL_REVIEW") { await exception(tx, id, "MANUAL_REVIEW", `${due.length} cycles due (${iso(due[0])} … ${iso(last!)}).`, last!); return 0; }
          if (s.missedPolicy === "LATEST_ONLY") toCreate = [last!];
          if (s.missedPolicy === "SKIP_MISSED") toCreate = last!.getTime() === today.getTime() ? [last!] : [];
          if (s.missedPolicy === "CATCH_UP_ALL") toCreate = due.slice(-s.maxCatchUp);
          const skipped = due.length - toCreate.length;
          if (skipped > 0) await exception(tx, id, "SKIPPED_CYCLES", `${skipped} missed cycle(s) not generated under ${s.missedPolicy}.`, last!);
        }
        let n = 0;
        let predId = pred?.id ?? null;
        for (const d of toCreate) {
          const t = await spawnOccurrence(tx, s, d, d, predId, holidays);
          if (t) { n++; predId = t.id; }
        }
        await advance();
        return n;
      });
    } catch (err) {
      log.error("recurrence spawn failed", { seriesId: id, err: String(err) });
      // Pointer is not advanced, so the next run retries the same cycle idempotently.
      await runTx((tx) => exception(tx, id, "SPAWN_FAILED", String(err).slice(0, 500), today)).catch(() => undefined);
    }
  }
  return { series: ids.length, created };
}

// Completion-driven hook (§34.3B), called inside the status-change transaction.
export async function onOccurrenceTerminal(tx: Tx, task: TaskWithRefs, _actor: Actor | null) {
  if (!task.seriesId) return;
  const s = await tx.recurringSeries.findUnique({ where: { id: task.seriesId } });
  if (!s || s.status !== "ACTIVE" || s.triggerMode !== "COMPLETION_DRIVEN") return;
  // Reopen → re-complete must not spawn a second successor.
  const successor = await tx.task.findFirst({ where: { seriesId: s.id, OR: [{ clonedFromId: task.id }, { occurrenceNumber: { gt: task.occurrenceNumber ?? 0 } }] } });
  if (successor) return;
  if (task.status === "DROPPED") {
    if (s.droppedPolicy !== "ALLOW") await exception(tx, s.id, "PREDECESSOR_BLOCKED", `Occurrence ${task.id} was dropped.`, task.scheduledDate);
    if (s.droppedPolicy === "BLOCK") return;
  }
  const holidays = await getHolidays(tx);
  const today = todayBiz();
  const p = asPattern(s);
  const base = s.anchorMode === "PREDECESSOR_COMPLETION" ? today : task.scheduledDate ?? today;
  const skips = new Set((await tx.seriesSkip.findMany({ where: { seriesId: s.id } })).map((k) => iso(k.date)));
  let next = s.anchorMode === "PREDECESSOR_COMPLETION" ? nextAnchoredOnCompletion(p, base, holidays) : firstDateOnOrAfter(p, addDays(base, 1), holidays);
  while (next && skips.has(iso(next))) next = firstDateOnOrAfter(p, addDays(next, 1), holidays);
  if (!next || (s.maxOccurrences && s.occurrenceCount >= s.maxOccurrences)) {
    await tx.recurringSeries.update({ where: { id: s.id }, data: { status: "ENDED", nextOccurrenceDate: null } });
    return;
  }
  await spawnOccurrence(tx, s, next, today, task.id, holidays);
  await tx.recurringSeries.update({ where: { id: s.id }, data: { nextOccurrenceDate: firstDateOnOrAfter(p, addDays(next, 1), holidays) } });
}

// ---------- Series CRUD & controls (§34.8) ----------

const WD: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export const seriesSchema = z.object({
  title: z.string().optional().default(""),
  description: z.string().nullish(),
  channelId: z.string().optional().default(""),
  ownerId: z.string().optional().default(""),
  priority: z.coerce.number().int().min(0).max(10).optional(),
  projectId: z.string().nullish(),
  dependencyTier: z.string().nullish(),
  cadence: z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY"]),
  interval: z.coerce.number().int().min(1).max(12).optional(),
  weekdays: z.array(z.union([z.number().int().min(0).max(6), z.string()])).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(31).nullish(),
  workingDaysOnly: z.boolean().optional(),
  startDate: z.string(),
  endDate: z.string().nullish(),
  maxOccurrences: z.coerce.number().int().positive().nullish(),
  deadlineOffsetDays: z.coerce.number().int().min(0).max(365).optional(),
  triggerMode: z.enum(["TIME_DRIVEN", "COMPLETION_DRIVEN"]).optional(),
  anchorMode: z.enum(["ORIGINAL_SCHEDULE", "PREDECESSOR_COMPLETION"]).optional(),
  missedPolicy: z.enum(["CATCH_UP_ALL", "LATEST_ONLY", "SKIP_MISSED", "MANUAL_REVIEW"]).optional(),
  overduePolicy: z.enum(["ALLOW", "BLOCK", "WARN"]).optional(),
  droppedPolicy: z.enum(["ALLOW", "BLOCK", "WARN"]).optional(),
  maxCatchUp: z.coerce.number().int().min(1).max(60).optional(),
});

async function validateSeries(tx: Tx, b: z.infer<typeof seriesSchema>) {
  const errors: Record<string, string> = {};
  if (b.title.trim().length < 3) errors.title = "Title needs at least 3 characters.";
  if (!b.channelId || !(await tx.channel.findFirst({ where: { id: b.channelId, active: true } }))) errors.channelId = "Pick a channel.";
  if (!b.ownerId || !(await tx.user.findFirst({ where: { id: b.ownerId, status: "ACTIVE" } }))) errors.ownerId = "Pick an active owner.";
  if (b.priority === undefined) errors.priority = "Priority is required.";
  const start = tryParseISODate(b.startDate);
  if (!start) errors.startDate = "Enter a valid start date.";
  const end = b.endDate ? tryParseISODate(b.endDate) : null;
  if (b.endDate && !end) errors.endDate = "Enter a valid date.";
  if (start && end && end < start) errors.endDate = "End date can't be before the start date.";
  const weekdays = (b.weekdays ?? []).map((w) => (typeof w === "number" ? w : WD[w.toUpperCase()]));
  if (weekdays.some((w) => w === undefined)) errors.weekdays = "Invalid weekday.";
  if ((b.cadence === "WEEKLY" || b.cadence === "BIWEEKLY") && weekdays.length === 0) errors.weekdays = "Pick at least one weekday.";
  if (b.dependencyTier && !DEP_TIERS.includes(b.dependencyTier as DepTier)) errors.dependencyTier = "Invalid dependency tier.";
  if (b.anchorMode === "PREDECESSOR_COMPLETION" && b.triggerMode !== "COMPLETION_DRIVEN") errors.anchorMode = "Completion anchoring needs the completion-driven trigger.";
  if (Object.keys(errors).length) throw fail.validation(errors);
  return {
    title: b.title.trim(), description: b.description?.trim() ?? "", channelId: b.channelId, ownerId: b.ownerId, priority: b.priority!,
    projectId: b.projectId || null, dependencyTier: (b.dependencyTier || null) as DepTier | null, cadence: b.cadence, interval: b.interval ?? 1,
    weekdays: [...new Set(weekdays)].sort(), dayOfMonth: b.cadence === "MONTHLY" ? b.dayOfMonth ?? start!.getUTCDate() : null,
    workingDaysOnly: b.workingDaysOnly ?? false, startDate: start!, endDate: end, maxOccurrences: b.maxOccurrences ?? null,
    deadlineOffsetDays: b.deadlineOffsetDays ?? 0, triggerMode: b.triggerMode ?? "TIME_DRIVEN", anchorMode: b.anchorMode ?? "ORIGINAL_SCHEDULE",
    missedPolicy: b.missedPolicy ?? "LATEST_ONLY", overduePolicy: b.overduePolicy ?? "WARN", droppedPolicy: b.droppedPolicy ?? "BLOCK", maxCatchUp: b.maxCatchUp ?? 10,
  };
}

export async function createSeries(actor: Actor, body: unknown) {
  const b = seriesSchema.parse(body);
  const created = await runTx(async (tx) => {
    const v = await validateSeries(tx, b);
    assertCan(actor, "MANAGE_SERIES", v.ownerId === actor.id);
    const holidays = await getHolidays(tx);
    const id = await allocateSeriesId(tx, actor.code);
    const first = firstDateOnOrAfter({ ...v }, v.startDate, holidays);
    const s = await tx.recurringSeries.create({ data: { id, ...v, nextOccurrenceDate: first, createdById: actor.id, updatedById: actor.id } });
    await audit(tx, { recordId: id, entityType: "SERIES", eventType: "SERIES_CREATED", actor, newValue: { ...v, startDate: iso(v.startDate), endDate: iso(v.endDate), firstOccurrence: iso(first) } });
    if (v.triggerMode === "COMPLETION_DRIVEN" && first) {
      await spawnOccurrence(tx, s, first, first > todayBiz() ? first : todayBiz(), null, holidays);
      await tx.recurringSeries.update({ where: { id }, data: { nextOccurrenceDate: firstDateOnOrAfter(v, addDays(first, 1), holidays) } });
    }
    return s;
  });
  if (created.triggerMode === "TIME_DRIVEN") await runTimeDriven();
  return prisma.recurringSeries.findUniqueOrThrow({ where: { id: created.id } });
}

export async function updateSeries(actor: Actor, id: string, body: unknown) {
  const b = z.object({ expectedVersion: z.number().int(), patch: seriesSchema.partial() }).parse(body);
  return runTx(async (tx) => {
    const s = await tx.recurringSeries.findUnique({ where: { id } });
    if (!s) throw fail.notFound("Series");
    assertCan(actor, "MANAGE_SERIES", s.ownerId === actor.id);
    if (s.status === "ENDED") throw fail.blocked("This series has ended.");
    const merged = { ...s, startDate: iso(s.startDate)!, endDate: iso(s.endDate), ...b.patch } as unknown as z.infer<typeof seriesSchema>;
    const v = await validateSeries(tx, merged);
    if (v.ownerId !== s.ownerId && !can(actor, "MANAGE_SERIES")) throw fail.forbidden("Only Admin or Leadership can reassign a series.");
    // Future-only edits (§34.8): existing occurrences are separate task rows and are never rewritten.
    const holidays = await getHolidays(tx);
    const lastOcc = await tx.task.findFirst({ where: { seriesId: id }, orderBy: { scheduledDate: "desc" }, select: { scheduledDate: true } });
    const from = [todayBiz(), lastOcc?.scheduledDate ? addDays(lastOcc.scheduledDate, 1) : v.startDate].reduce((a, c) => (c > a ? c : a));
    const nextOccurrenceDate = firstDateOnOrAfter(v, from, holidays);
    const { prev, next } = diff(s as unknown as Record<string, unknown>, v as unknown as Record<string, unknown>);
    const r = await tx.recurringSeries.updateMany({ where: { id, version: b.expectedVersion }, data: { ...v, nextOccurrenceDate, version: { increment: 1 }, updatedById: actor.id } });
    if (r.count === 0) throw fail.stale(await tx.recurringSeries.findUnique({ where: { id } }));
    await audit(tx, { recordId: id, entityType: "SERIES", eventType: "SERIES_UPDATED", actor, previousValue: prev, newValue: { ...next, nextOccurrenceDate: iso(nextOccurrenceDate) } });
    return tx.recurringSeries.findUniqueOrThrow({ where: { id } });
  });
}

export async function seriesAction(actor: Actor, id: string, body: unknown) {
  const b = z.object({ action: z.enum(["PAUSE", "RESUME", "END", "SKIP", "RESOLVE_EXCEPTION"]), date: z.string().nullish(), followupDate: z.string().nullish(), reason: z.string().nullish(), exceptionId: z.string().nullish() }).parse(body);
  return runTx(async (tx) => {
    const s = await tx.recurringSeries.findUnique({ where: { id } });
    if (!s) throw fail.notFound("Series");
    assertCan(actor, "MANAGE_SERIES", s.ownerId === actor.id);
    const reason = b.reason?.trim();
    const data: Prisma.RecurringSeriesUpdateInput = {};
    // Brief §10: Skip and Pause are blocked until a valid follow-up/resume date is given.
    const follow = b.followupDate ? tryParseISODate(b.followupDate) : null;
    if ((b.action === "PAUSE" || b.action === "SKIP") && !follow)
      throw fail.validation({ followupDate: b.action === "PAUSE" ? "Pick a resume / follow-up date." : "Pick a follow-up date for the skipped occurrence." });
    if (follow && follow < todayBiz()) throw fail.validation({ followupDate: "The follow-up date can't be in the past." });
    if (b.action === "PAUSE") {
      if (s.status !== "ACTIVE") throw fail.conflict("Series is not active.");
      if (!reason) throw fail.validation({ reason: "Say why the series is paused." });
      data.status = "PAUSED"; data.pausedAt = new Date(); data.pauseReason = reason; data.resumeDate = follow; data.pausedById = actor.id;
    }
    if (b.action === "RESUME") { if (s.status !== "PAUSED") throw fail.conflict("Series is not paused."); data.status = "ACTIVE"; data.pausedAt = null; data.pauseReason = null; data.resumeDate = null; data.pausedById = null; }
    if (b.action === "END") { if (!reason) throw fail.validation({ reason: "A reason is required to end a series." }); data.status = "ENDED"; data.nextOccurrenceDate = null; }
    if (b.action === "SKIP") {
      const d = b.date ? tryParseISODate(b.date) : null;
      if (!d) throw fail.validation({ date: "Pick the occurrence date to skip." });
      if (!reason) throw fail.validation({ reason: "A reason is required to skip an occurrence." });
      if (d < todayBiz()) throw fail.validation({ date: "Only future occurrences can be skipped." });
      if (await tx.task.findFirst({ where: { seriesId: id, scheduledDate: d } })) throw fail.conflict("That occurrence already exists; drop it instead.");
      await tx.seriesSkip.create({ data: { seriesId: id, date: d, reason, followupDate: follow!, byId: actor.id } });
    }
    if (b.action === "RESOLVE_EXCEPTION") {
      if (!b.exceptionId) throw fail.validation({ exceptionId: "Missing exception." });
      await tx.seriesException.update({ where: { id: b.exceptionId, seriesId: id }, data: { resolved: true, resolvedBy: actor.id } });
    }
    if (Object.keys(data).length) await tx.recurringSeries.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedById: actor.id } });
    await audit(tx, { recordId: id, entityType: "SERIES", eventType: `SERIES_${b.action}`, actor, reason, newValue: { date: b.date ?? null, followupDate: b.followupDate ?? null, exceptionId: b.exceptionId ?? null } });
    return { ok: true };
  });
}

export async function listSeries(actor: Actor) {
  const rows = await prisma.recurringSeries.findMany({
    where: can(actor, "MANAGE_SERIES") ? {} : { ownerId: actor.id },
    include: { owner: { select: { id: true, name: true } }, channel: { select: { name: true } }, exceptions: { where: { resolved: false }, orderBy: { createdAt: "desc" } }, skips: true, tasks: { select: { id: true, status: true, scheduledDate: true, deadline: true, softDeleted: true }, orderBy: { scheduledDate: "desc" }, take: 12 } },
    orderBy: [{ status: "asc" }, { title: "asc" }],
  });
  return rows.map((s) => ({
    ...s, startDate: iso(s.startDate), endDate: iso(s.endDate), nextOccurrenceDate: iso(s.nextOccurrenceDate), resumeDate: iso(s.resumeDate),
    skips: s.skips.map((k) => ({ ...k, date: iso(k.date), followupDate: iso(k.followupDate) })),
    exceptions: s.exceptions.map((e) => ({ ...e, date: iso(e.date) })),
    tasks: s.tasks.map((t) => ({ ...t, scheduledDate: iso(t.scheduledDate), deadline: iso(t.deadline) })),
    canManage: can(actor, "MANAGE_SERIES", s.ownerId === actor.id),
  }));
}
