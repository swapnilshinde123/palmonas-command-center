import { loadActor, type Actor } from "../actor";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { addDays, businessHHMM, iso, todayBiz } from "@/lib/dates";
import { taskInclude, toDTO, visibleWhere, type TaskDTO } from "../task-core";
import { kpis, workload } from "../metrics";
import { projectRollups } from "../projects";
import { enqueue } from "./enqueue";
import { tx as runTx } from "@/lib/db";

const row = (t: TaskDTO) => ({ id: t.id, name: t.name, channel: t.channel.name, priority: t.priority, status: t.statusLabel, deadline: t.deadline!, timeliness: t.timelinessLabel, pendingFrom: t.pendingFrom });

type U = Actor;

async function personalPayload(u: U, today: Date) {
  const tasks = (await prisma.task.findMany({ where: { softDeleted: false, status: { in: ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"] }, ownerId: u.id }, include: taskInclude, orderBy: { deadline: "asc" } })).map((t) => toDTO(t, today));
  const todayIso = iso(today)!;
  const weekAhead = iso(addDays(today, 7))!;
  const privileged = u.role !== "MEMBER";
  const transfers = await prisma.transfer.findMany({ where: { toUserId: u.id, status: "PENDING", task: { softDeleted: false } }, include: { task: { include: taskInclude } } });
  const approvals = privileged
    ? await prisma.extensionRequest.findMany({ where: { status: "PENDING", requestedById: { not: u.id }, task: { softDeleted: false } }, include: { task: { include: taskInclude } } })
    : [];
  const sections = [
    { title: "Overdue", rows: tasks.filter((t) => t.timeliness === "OVERDUE").map(row) },
    { title: "Due today", rows: tasks.filter((t) => t.deadline === todayIso).map(row) },
    { title: "Upcoming (7 days)", rows: tasks.filter((t) => t.deadline! > todayIso && t.deadline! <= weekAhead).map(row) },
    { title: "Blocked / waiting on others", rows: tasks.filter((t) => t.escalationRequired || t.status === "ON_HOLD" || t.pendingFrom).map(row) },
    { title: "Transfers awaiting your response", rows: transfers.map((t) => row(toDTO(t.task, today))) },
    ...(privileged ? [{ title: "Extension requests awaiting your decision", rows: approvals.map((a) => row(toDTO(a.task, today))) }] : []),
  ];
  return { date: todayIso, dataAsOf: new Date().toISOString(), sections, empty: sections.every((s) => s.rows.length === 0) };
}

async function executivePayload(u: U, today: Date) {
  const actor = { ...u };
  const [k, w, projects, escalations, pendingT, pendingE, pendingW, pendingC, changes, critical] = await Promise.all([
    kpis(actor), workload(actor), projectRollups(actor),
    prisma.escalation.groupBy({ by: ["level"], where: { active: true, task: { softDeleted: false } }, _count: true }),
    prisma.transfer.count({ where: { status: "PENDING" } }),
    prisma.extensionRequest.count({ where: { status: "PENDING" } }),
    prisma.waiverRequest.count({ where: { status: "PENDING" } }),
    prisma.cancellationRequest.count({ where: { status: "PENDING" } }),
    prisma.auditEvent.groupBy({ by: ["eventType"], where: { at: { gte: new Date(Date.now() - 86_400_000) } }, _count: true }),
    prisma.task.findMany({ where: { softDeleted: false, ...visibleWhere(actor), escalations: { some: { active: true, level: "L3" } } }, include: taskInclude }),
  ]);
  return {
    date: iso(today)!, dataAsOf: k.dataAsOf,
    kpis: { "Completed on time": k.completedOnTime, "Completed late": k.completedLate, "In progress": k.inProgress, Overdue: k.overdue, "Total active": k.inProgress + k.overdue },
    workload: w.map((x) => ({ name: x.name, active: x.active, overdue: x.overdue })),
    escalations: Object.fromEntries(["L1", "L2", "L3"].map((l) => [l, escalations.find((e) => e.level === l)?._count ?? 0])),
    critical: critical.map((t) => row(toDTO(t, today))),
    pending: { Transfers: pendingT, Extensions: pendingE, Waivers: pendingW, Cancellations: pendingC },
    projects: projects.filter((p) => p.status === "ACTIVE").map((p) => ({ name: p.name, pct: p.taskCompletionPct, overdue: p.overdue })),
    changes: Object.fromEntries(changes.map((c) => [c.eventType, c._count])),
  };
}

// Runs every worker tick; dedup key per user+date makes it once-a-day and self-healing if the worker was down at 09:00.
export async function generateDigests(now = new Date()) {
  const cfg = await getConfig("notifications");
  if (businessHHMM(now) < cfg.digestTime) return { personal: 0, executive: 0 };
  const today = todayBiz(now);
  const date = iso(today)!;
  const marker = `digest:${date}`;
  if (await prisma.workerHeartbeat.findUnique({ where: { name: marker } })) return { personal: 0, executive: 0 };
  if (!cfg.digestsEnabled) return { personal: 0, executive: 0, disabled: true };
  const users = (await Promise.all((await prisma.user.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map((u) => loadActor(u.id)))).filter(Boolean) as Actor[];
  let personal = 0;
  let executive = 0;
  for (const u of users) {
    const p = await personalPayload(u, today);
    if (!p.empty || cfg.sendEmptyPersonalDigest) {
      await runTx((tx) => enqueue(tx, { eventType: "MORNING_DIGEST_PERSONAL", transitionId: date, taskId: null, recipientIds: [u.id], subject: `Your Palmonas ops digest · ${date}`, payload: p }));
      personal++;
    }
    if (u.role !== "MEMBER") {
      const e = await executivePayload(u, today);
      await runTx((tx) => enqueue(tx, { eventType: "EXECUTIVE_DIGEST", transitionId: date, taskId: null, recipientIds: [u.id], subject: `Executive ops digest · ${date}`, payload: e }));
      executive++;
    }
  }
  // Marker only after every user was processed; a crash midway re-runs and dedup keys absorb the repeats.
  await prisma.workerHeartbeat.create({ data: { name: marker, lastRunAt: new Date(), detail: { personal, executive } } });
  return { personal, executive };
}
