import { SYSTEM_ACTOR } from "./actor";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { todayBiz } from "@/lib/dates";
import { isPrivileged, type Actor } from "./rbac";
import { visibleWhere } from "./task-core";
import { ACTIVE_STATUSES, timeliness } from "./sla";

// Metric dictionary (§11.1) — the same predicates feed the dashboard, digests and reconciliation.
export const METRIC_DEFINITIONS = {
  completedOnTime: "Status Completed and completion date (IST) ≤ operative deadline.",
  completedLate: "Status Completed and completion date (IST) > operative deadline.",
  inProgress: "Status Not started / In progress / On hold and today (IST) ≤ operative deadline.",
  overdue: "Status Not started / In progress / On hold and today (IST) > operative deadline.",
  activeWorkload: "Owner's tasks in Not started / In progress / On hold. Subtask owners are not counted (DEC-012).",
  exclusions: "Always excludes soft-deleted tasks and names matching the exclusion gate (QA*/test*). Dropped tasks are excluded from all four KPI cards.",
};

export const metricBase: Prisma.TaskWhereInput = { softDeleted: false, excludedFromMetrics: false };

export async function kpis(actor: Actor) {
  const today = todayBiz();
  const rows = await prisma.task.findMany({
    where: { AND: [metricBase, isPrivileged(actor) ? {} : { ownerId: actor.id }, { status: { not: "DROPPED" } }] },
    select: { status: true, assignedDate: true, deadline: true, completedAt: true },
  });
  const out = { completedOnTime: 0, completedLate: 0, inProgress: 0, overdue: 0 };
  for (const r of rows) {
    const t = timeliness(r, today);
    if (t === "ON_TIME") out.completedOnTime++;
    else if (t === "LATE") out.completedLate++;
    else if (t === "IN_PROGRESS") out.inProgress++;
    else if (t === "OVERDUE") out.overdue++;
  }
  const [activeEscalations, l3] = await Promise.all([
    prisma.escalation.count({ where: { active: true, task: { softDeleted: false, ...visibleWhere(actor) } } }),
    prisma.escalation.count({ where: { active: true, level: "L3", task: { softDeleted: false, ...visibleWhere(actor) } } }),
  ]);
  return { ...out, activeEscalations, l3Escalations: l3, dataAsOf: new Date().toISOString(), scope: isPrivileged(actor) ? "team" : "self" };
}

export async function workload(actor: Actor) {
  const today = todayBiz();
  const users = await prisma.user.findMany({ where: { status: "ACTIVE", ...(isPrivileged(actor) ? {} : { id: actor.id }) }, orderBy: { name: "asc" } });
  const tasks = await prisma.task.findMany({
    where: { ...metricBase, status: { in: ACTIVE_STATUSES }, ownerId: { in: users.map((u) => u.id) } },
    select: { ownerId: true, deadline: true, priority: true },
  });
  return users.map((u) => {
    const mine = tasks.filter((t) => t.ownerId === u.id);
    return { id: u.id, name: u.name, code: u.code, active: mine.length, overdue: mine.filter((t) => today > t.deadline).length, p0: mine.filter((t) => t.priority === 0).length };
  });
}

// Admin reconciliation (§18.5, QA-030): recount KPIs with plain SQL, independent of the TS predicates.
export async function reconcile() {
  const today = todayBiz();
  const rows = await prisma.$queryRaw<{ k: string; n: bigint }[]>`
    SELECT CASE
      WHEN status = 'COMPLETED' AND (("completedAt" AT TIME ZONE 'Asia/Kolkata')::date <= deadline) THEN 'completedOnTime'
      WHEN status = 'COMPLETED' THEN 'completedLate'
      WHEN deadline < ${today}::date THEN 'overdue'
      ELSE 'inProgress' END AS k, count(*) AS n
    FROM "Task" WHERE "softDeleted" = false AND "excludedFromMetrics" = false AND status <> 'DROPPED'
    GROUP BY 1`;
  const sql = Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
  const app = await kpis(SYSTEM_ACTOR);
  const keys = ["completedOnTime", "completedLate", "inProgress", "overdue"] as const;
  return { sql, app, matches: keys.every((k) => (sql[k] ?? 0) === app[k]) };
}
