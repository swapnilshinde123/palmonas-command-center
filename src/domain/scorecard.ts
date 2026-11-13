import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, tx as runTx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { businessDateOf, monthBounds, monthKey, todayBiz } from "@/lib/dates";
import { assertCan, can, isPrivileged, type Actor } from "./rbac";
import { audit } from "./audit";

// DEC-021/026: interpretation of "Delivery 40/20, Dependencies 25, Discipline 15" — versioned so it can be replaced.
export const DEFAULT_POLICY = {
  delivery: { onTimePoints: 4, latePoints: 2 },
  dependencies: { I: 2, WB: 3.5, E: 5, monthlyCap: 25 },
  discipline: { base: 15, penaltyPerUnwaivedExtension: 2, inheritedDelayPenalty: 2, floor: 0 },
};
export type ScorePolicyConfig = typeof DEFAULT_POLICY;

export async function policyFor(month: string) {
  const p = await prisma.scorePolicy.findFirst({ where: { effectiveFrom: { lte: month } }, orderBy: { version: "desc" } });
  return { version: p?.version ?? 0, config: (p?.config as ScorePolicyConfig | undefined) ?? DEFAULT_POLICY };
}

export interface LedgerRow {
  userId: string;
  name: string;
  completedOnTime: number;
  completedLate: number;
  inheritedDelays: number;
  extensionsApproved: number;
  extensionsWaived: number;
  depI: number;
  depWB: number;
  depE: number;
  deliveryPts: number;
  dependencyPts: number;
  disciplinePts: number;
  adjustments: number;
  total: number;
  evidence: { completedTasks: string[]; dependencySources: { taskId: string; source: "SUBTASK" | "TASK"; ref: string; tier: string }[] };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function computeMonth(month: string): Promise<{ policyVersion: number; rows: LedgerRow[] }> {
  const { start, end } = monthBounds(month);
  // Business-month bounds as instants: 00:00 IST on day 1 → 00:00 IST on day 1 of next month.
  const from = new Date(start.getTime() - 330 * 60_000);
  const to = new Date(end.getTime() - 330 * 60_000);
  const { version, config } = await policyFor(month);
  const users = await prisma.user.findMany({ orderBy: { name: "asc" } });

  const completed = await prisma.task.findMany({
    where: { status: "COMPLETED", softDeleted: false, excludedFromMetrics: false, completedAt: { gte: from, lt: to } },
    select: { id: true, ownerId: true, deadline: true, completedAt: true, pocType: true, subtasks: { select: { id: true, status: true, depType: true, completedById: true } } },
  });
  const overdueTransfers = await prisma.transfer.findMany({
    where: { status: "APPROVED", wasOverdueAtRequest: true, decidedAt: { gte: from, lt: to }, task: { softDeleted: false, excludedFromMetrics: false } },
    select: { fromUserId: true, taskId: true },
  });
  const extensions = await prisma.extensionRequest.findMany({
    where: { status: "APPROVED", decidedAt: { gte: from, lt: to }, task: { softDeleted: false, excludedFromMetrics: false } },
    select: { requestedById: true, waivers: { select: { status: true } } },
  });
  const adjustments = await prisma.scoreAdjustment.groupBy({ by: ["userId"], where: { month }, _sum: { points: true } });

  const rows = new Map<string, LedgerRow>();
  for (const u of users) rows.set(u.id, { userId: u.id, name: u.name, completedOnTime: 0, completedLate: 0, inheritedDelays: 0, extensionsApproved: 0, extensionsWaived: 0, depI: 0, depWB: 0, depE: 0, deliveryPts: 0, dependencyPts: 0, disciplinePts: 0, adjustments: 0, total: 0, evidence: { completedTasks: [], dependencySources: [] } });

  for (const t of completed) {
    // §26.3: delivery credit goes to the owner at completion (the transfer recipient), in the completion month.
    const row = rows.get(t.ownerId);
    if (!row) continue;
    const onTime = businessDateOf(t.completedAt!).getTime() <= t.deadline.getTime();
    if (onTime) row.completedOnTime++; else row.completedLate++;
    row.evidence.completedTasks.push(t.id);
    // §25.3–25.4: subtask evidence supersedes the task-level tag; never both.
    const subs = t.subtasks.filter((s) => s.status === "COMPLETED" && s.depType);
    if (subs.length) {
      for (const s of subs) {
        row[`dep${s.depType!}` as "depI" | "depWB" | "depE"]++;
        row.evidence.dependencySources.push({ taskId: t.id, source: "SUBTASK", ref: s.id, tier: s.depType! });
      }
    } else if (t.pocType) {
      row[`dep${t.pocType}` as "depI" | "depWB" | "depE"]++;
      row.evidence.dependencySources.push({ taskId: t.id, source: "TASK", ref: t.id, tier: t.pocType });
    }
  }
  // §26.2: delay already incurred before transfer stays with the sender.
  for (const tr of overdueTransfers) rows.get(tr.fromUserId) && rows.get(tr.fromUserId)!.inheritedDelays++;
  for (const e of extensions) {
    const row = rows.get(e.requestedById);
    if (!row) continue;
    row.extensionsApproved++;
    if (e.waivers.some((w) => w.status === "APPROVED")) row.extensionsWaived++;
  }
  for (const a of adjustments) rows.get(a.userId) && (rows.get(a.userId)!.adjustments = Number(a._sum.points ?? 0));

  for (const row of rows.values()) {
    row.deliveryPts = row.completedOnTime * config.delivery.onTimePoints + row.completedLate * config.delivery.latePoints;
    row.dependencyPts = Math.min(config.dependencies.monthlyCap, row.depI * config.dependencies.I + row.depWB * config.dependencies.WB + row.depE * config.dependencies.E);
    const penalty = Math.max(0, row.extensionsApproved - row.extensionsWaived) * config.discipline.penaltyPerUnwaivedExtension + row.inheritedDelays * config.discipline.inheritedDelayPenalty;
    row.disciplinePts = Math.max(config.discipline.floor, config.discipline.base - penalty);
    row.total = r2(row.deliveryPts + row.dependencyPts + row.disciplinePts + row.adjustments);
    row.dependencyPts = r2(row.dependencyPts);
  }
  return { policyVersion: version, rows: [...rows.values()] };
}

export async function scorecard(actor: Actor, month: string = monthKey(todayBiz())) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw fail.validation({ month: "Use YYYY-MM." });
  assertCan(actor, "VIEW_TEAM_SCORECARD", true);
  const closed = await prisma.scorecardPeriod.findUnique({ where: { month } });
  let rows: LedgerRow[];
  let policyVersion: number;
  let postCloseAdjustments: Record<string, number> = {};
  if (closed) {
    // Closed periods are reproducible: served from the frozen snapshot; later corrections are shown separately (§11.4, §38.4).
    rows = (closed.snapshot as unknown as LedgerRow[]);
    policyVersion = closed.policyVersion;
    const later = await prisma.scoreAdjustment.groupBy({ by: ["userId"], where: { month, createdAt: { gt: closed.closedAt } }, _sum: { points: true } });
    postCloseAdjustments = Object.fromEntries(later.map((l) => [l.userId, Number(l._sum.points ?? 0)]));
  } else {
    ({ rows, policyVersion } = await computeMonth(month));
  }
  const active = new Set((await prisma.user.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map((u) => u.id));
  const visible = rows.filter((r) => (isPrivileged(actor) ? active.has(r.userId) || r.total !== 0 : r.userId === actor.id));
  const adjustments = can(actor, "OVERRIDE_SCORECARD") ? await prisma.scoreAdjustment.findMany({ where: { month }, orderBy: { createdAt: "desc" } }) : [];
  return {
    month, closed: !!closed, closedAt: closed?.closedAt ?? null, policyVersion, policy: (await policyFor(month)).config,
    rows: visible.map((r) => ({ ...r, postCloseAdjustment: postCloseAdjustments[r.userId] ?? 0 })).sort((a, b) => b.total - a.total),
    adjustments: adjustments.map((a) => ({ ...a, points: Number(a.points) })),
    canOverride: can(actor, "OVERRIDE_SCORECARD"), canClose: can(actor, "CLOSE_SCORECARD_PERIOD"),
  };
}

export async function closePeriod(actor: Actor, month: string) {
  assertCan(actor, "CLOSE_SCORECARD_PERIOD");
  if (month >= monthKey(todayBiz())) throw fail.validation({ month: "Only past months can be closed." });
  const { rows, policyVersion } = await computeMonth(month);
  return runTx(async (tx) => {
    if (await tx.scorecardPeriod.findUnique({ where: { month } })) throw fail.conflict("This period is already closed.");
    await tx.scorecardPeriod.create({ data: { month, policyVersion, snapshot: rows as unknown as Prisma.InputJsonValue, closedById: actor.id } });
    await audit(tx, { recordId: month, entityType: "SCORECARD", eventType: "SCORECARD_PERIOD_CLOSED", actor, newValue: { policyVersion, totals: rows.map((r) => [r.name, r.total]) } });
    return { ok: true };
  });
}

export async function adjustScore(actor: Actor, body: unknown) {
  const b = z.object({ userId: z.string(), month: z.string().regex(/^\d{4}-\d{2}$/), points: z.number().refine((n) => n !== 0 && Math.abs(n) <= 100), reason: z.string().nullish() }).parse(body);
  assertCan(actor, "OVERRIDE_SCORECARD");
  if (!b.reason?.trim()) throw fail.validation({ reason: "A reason is required." });
  return runTx(async (tx) => {
    const closed = await tx.scorecardPeriod.findUnique({ where: { month: b.month } });
    const adj = await tx.scoreAdjustment.create({ data: { userId: b.userId, month: b.month, points: b.points, kind: closed ? "CORRECTION" : "OVERRIDE", reason: b.reason!.trim(), createdById: actor.id } });
    await audit(tx, { recordId: b.month, entityType: "SCORECARD", eventType: closed ? "SCORECARD_CORRECTION" : "SCORECARD_OVERRIDE", actor, reason: b.reason, relatedEntityId: b.userId, newValue: { points: b.points } });
    return adj;
  });
}
