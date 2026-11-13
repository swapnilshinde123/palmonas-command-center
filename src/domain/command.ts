import { prisma } from "@/lib/db";
import { addDays, iso, monthKey, todayBiz } from "@/lib/dates";
import { getConfig } from "@/lib/config";
import { isPrivileged, type Actor } from "./rbac";
import { metricBase } from "./metrics";
import { visibleWhere } from "./task-core";
import { ACTIVE_STATUSES, timeliness } from "./sla";

type Bucket = { key: string; label: string; active: number; overdue: number; dueSoon: number; onHold: number; completedThisMonth: number; total: number };
const empty = (key: string, label: string): Bucket => ({ key, label, active: 0, overdue: 0, dueSoon: 0, onHold: 0, completedThisMonth: 0, total: 0 });

// Brief §3: everyone sees team-wide aggregate counts in the order Owner → Channel → Priority.
// The response carries counts only (no task titles, POCs or IDs); `drilldown` tells the client
// whether the viewer may open the records behind a count, and the task APIs enforce it again.
export async function commandCenter(actor: Actor) {
  const today = todayBiz();
  const month = monthKey(today);
  const { deadlineDays, followupDays } = await getConfig("dueSoon");
  const soon = addDays(today, deadlineDays);
  const [rows, users, channels] = await Promise.all([
    prisma.task.findMany({
      where: { ...metricBase, status: { not: "DROPPED" } },
      select: { ownerId: true, channelId: true, priority: true, status: true, assignedDate: true, deadline: true, completedAt: true },
    }),
    prisma.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.channel.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
  ]);
  const owners = new Map(users.map((u) => [u.id, empty(u.id, u.name)]));
  const chans = new Map(channels.map((c) => [c.id, empty(c.id, c.name)]));
  const prios = new Map<number, Bucket>();
  const totals = empty("all", "Team");
  for (const t of rows) {
    const active = ACTIVE_STATUSES.includes(t.status);
    const tl = timeliness(t, today);
    const doneThisMonth = t.status === "COMPLETED" && !!t.completedAt && monthKey(t.completedAt) === month;
    const p = prios.get(t.priority) ?? empty(String(t.priority), `P${t.priority}`);
    prios.set(t.priority, p);
    const buckets = [owners.get(t.ownerId), chans.get(t.channelId), p, totals].filter(Boolean) as Bucket[];
    for (const b of buckets) {
      b.total++;
      if (active) b.active++;
      if (tl === "OVERDUE") b.overdue++;
      if (active && t.deadline >= today && t.deadline <= soon) b.dueSoon++;
      if (t.status === "ON_HOLD") b.onHold++;
      if (doneThisMonth) b.completedThisMonth++;
    }
  }
  const sortBy = (a: Bucket, b: Bucket) => b.active - a.active || a.label.localeCompare(b.label);
  const me = actor.id;
  const myWhere = { softDeleted: false, ownerId: me, status: { in: ACTIVE_STATUSES } };
  const [mine, myDue, myFollow, myPending, myEsc, approvals, recent] = await Promise.all([
    prisma.task.count({ where: myWhere }),
    prisma.task.count({ where: { ...myWhere, deadline: { lte: soon } } }),
    prisma.task.count({ where: { ...myWhere, followupDate: { lte: addDays(today, followupDays) } } }),
    prisma.task.count({ where: { ...myWhere, pocType: { not: null } } }),
    prisma.escalation.count({ where: { active: true, task: { softDeleted: false }, OR: [{ assigneeId: me }, { task: { ownerId: me } }] } }),
    isPrivileged(actor)
      ? Promise.all([prisma.extensionRequest.count({ where: { status: "PENDING", requestedById: { not: me } } }), prisma.waiverRequest.count({ where: { status: "PENDING", requestedById: { not: me } } }), prisma.transfer.count({ where: { status: "PENDING" } }), prisma.cancellationRequest.count({ where: { status: "PENDING" } })]).then((a) => a.reduce((x, y) => x + y, 0))
      : prisma.transfer.count({ where: { status: "PENDING", toUserId: me } }),
    // Recent activity limited to tasks the viewer can see.
    prisma.auditEvent.findMany({
      where: { entityType: "TASK", recordId: { in: (await prisma.task.findMany({ where: { softDeleted: false, ...visibleWhere(actor) }, select: { id: true }, orderBy: { updatedAt: "desc" }, take: 60 })).map((t) => t.id) } },
      orderBy: { seq: "desc" }, take: 12,
    }),
  ]);
  const names = Object.fromEntries((await prisma.task.findMany({ where: { id: { in: recent.map((r) => r.recordId) } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
  return {
    asOf: new Date().toISOString(),
    today: iso(today),
    drilldown: isPrivileged(actor),
    totals,
    owners: [...owners.values()].filter((b) => b.total > 0).sort(sortBy),
    channels: [...chans.values()].filter((b) => b.total > 0).sort(sortBy),
    priorities: [...prios.values()].sort((a, b) => Number(a.key) - Number(b.key)),
    my: { active: mine, dueSoon: myDue, followupSoon: myFollow, pendingFrom: myPending, escalations: myEsc, approvals },
    recent: recent.map((r) => ({ id: r.id, taskId: r.recordId, task: names[r.recordId] ?? r.recordId, eventType: r.eventType, actorName: r.actorName, at: r.at.toISOString(), reason: r.reason })),
  };
}

// Due Soon / Follow-up Soon (brief §5): both reasons, overdue kept visible, configurable windows.
export async function dueView(actor: Actor, raw: { view?: string } = {}) {
  const today = todayBiz();
  const cfg = await getConfig("dueSoon");
  const view = raw.view === "team" && isPrivileged(actor) ? "team" : "mine";
  const base = { softDeleted: false, status: { in: ACTIVE_STATUSES }, ...visibleWhere(actor), ...(view === "mine" ? { ownerId: actor.id } : {}) };
  const { taskInclude, toDTO } = await import("./task-core");
  const rows = await prisma.task.findMany({
    where: { ...base, OR: [{ deadline: { lte: addDays(today, cfg.deadlineDays) } }, { followupDate: { lte: addDays(today, cfg.followupDays) } }] },
    include: taskInclude, orderBy: [{ deadline: "asc" }, { priority: "asc" }],
  });
  const series = await prisma.recurringSeries.findMany({
    where: { status: "PAUSED", resumeDate: { lte: addDays(today, cfg.followupDays) }, ...(view === "mine" || !isPrivileged(actor) ? { ownerId: actor.id } : {}) },
    select: { id: true, title: true, resumeDate: true, pauseReason: true, owner: { select: { name: true } } },
  });
  const skips = await prisma.seriesSkip.findMany({
    where: { followupDate: { lte: addDays(today, cfg.followupDays) }, series: { status: { not: "ENDED" }, ...(view === "mine" || !isPrivileged(actor) ? { ownerId: actor.id } : {}) } },
    include: { series: { select: { id: true, title: true, owner: { select: { name: true } } } } },
  });
  const tasks = rows.map((t) => {
    const d = toDTO(t, today, actor);
    const reasons: string[] = [];
    if (t.deadline < today) reasons.push("Overdue");
    else if (t.deadline <= addDays(today, cfg.deadlineDays)) reasons.push("Deadline approaching");
    if (t.followupDate && t.followupDate <= addDays(today, cfg.followupDays)) reasons.push(t.followupDate < today ? "Follow-up overdue" : "Follow-up due");
    return { ...d, reasons };
  });
  return {
    view, windows: cfg, today: iso(today),
    tasks,
    seriesFollowups: [
      ...series.map((s) => ({ seriesId: s.id, title: s.title, owner: s.owner.name, date: iso(s.resumeDate), kind: "Paused — resume / follow up", note: s.pauseReason })),
      ...skips.map((k) => ({ seriesId: k.series.id, title: k.series.title, owner: k.series.owner.name, date: iso(k.followupDate), kind: `Skipped ${iso(k.date)} — follow up`, note: k.reason })),
    ].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
  };
}

// Channels page (brief §11): counts per channel for everyone; records only through the task API.
export async function channelSummary(actor: Actor) {
  const cc = await commandCenter(actor);
  return { drilldown: cc.drilldown, channels: cc.channels };
}
