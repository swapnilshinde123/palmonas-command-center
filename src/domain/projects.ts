import { z } from "zod";
import type { MilestoneStatus, ProjectStatus } from "@prisma/client";
import { prisma, tx as runTx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { iso, todayBiz, tryParseISODate } from "@/lib/dates";
import { getConfig } from "@/lib/config";
import { assertCan, can, type Actor } from "./rbac";
import { audit, diff } from "./audit";
import { allocateProjectId } from "./ids";
import { taskInclude, toDTO, visibleWhere } from "./task-core";
import { isActive } from "./sla";

const projectSchema = z.object({
  name: z.string().optional().default(""),
  description: z.string().nullish(),
  ownerId: z.string().optional().default(""),
  startDate: z.string().nullish(),
  targetDate: z.string().nullish(),
  channels: z.array(z.string()).optional(),
});

async function validateProject(b: z.infer<typeof projectSchema>, excludeId?: string) {
  const errors: Record<string, string> = {};
  const name = b.name.trim();
  if (name.length < 2) errors.name = "Project name is required.";
  else if (await prisma.project.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) } })) errors.name = "A project with this name already exists.";
  if (!b.ownerId || !(await prisma.user.findFirst({ where: { id: b.ownerId, status: "ACTIVE" } }))) errors.ownerId = "Pick an active project owner.";
  const start = b.startDate ? tryParseISODate(b.startDate) : null;
  const target = b.targetDate ? tryParseISODate(b.targetDate) : null;
  if (b.startDate && !start) errors.startDate = "Enter a valid date.";
  if (b.targetDate && !target) errors.targetDate = "Enter a valid date.";
  if (start && target && target < start) errors.targetDate = "Target date can't be before the start date.";
  if (Object.keys(errors).length) throw fail.validation(errors);
  return { name, description: b.description?.trim() ?? "", ownerId: b.ownerId, startDate: start, targetDate: target, channels: b.channels ?? [] };
}

export async function createProject(actor: Actor, body: unknown) {
  const v = await validateProject(projectSchema.parse(body));
  assertCan(actor, "MANAGE_PROJECTS", v.ownerId === actor.id);
  return runTx(async (tx) => {
    const id = await allocateProjectId(tx);
    const p = await tx.project.create({ data: { id, ...v, createdById: actor.id, updatedById: actor.id } });
    await audit(tx, { recordId: id, entityType: "PROJECT", eventType: "PROJECT_CREATED", actor, newValue: { ...v, startDate: iso(v.startDate), targetDate: iso(v.targetDate) } });
    return p;
  });
}

export async function updateProject(actor: Actor, id: string, body: unknown) {
  const b = z.object({ expectedVersion: z.number().int(), patch: projectSchema.partial() }).parse(body);
  return runTx(async (tx) => {
    const p = await tx.project.findUnique({ where: { id } });
    if (!p) throw fail.notFound("Project");
    assertCan(actor, "MANAGE_PROJECTS", p.ownerId === actor.id);
    if (p.status === "ARCHIVED") throw fail.blocked("Archived projects are read-only. Reactivate it first.");
    const v = await validateProject({ name: p.name, ownerId: p.ownerId, description: p.description, channels: p.channels, startDate: iso(p.startDate), targetDate: iso(p.targetDate), ...b.patch } as z.infer<typeof projectSchema>, id);
    const { prev, next, changed } = diff(p as unknown as Record<string, unknown>, v as unknown as Record<string, unknown>);
    if (!changed.length) return p;
    const r = await tx.project.updateMany({ where: { id, version: b.expectedVersion }, data: { ...v, version: { increment: 1 }, updatedById: actor.id } });
    if (r.count === 0) throw fail.stale(await tx.project.findUnique({ where: { id } }));
    await audit(tx, { recordId: id, entityType: "PROJECT", eventType: "PROJECT_UPDATED", actor, previousValue: prev, newValue: next });
    return tx.project.findUniqueOrThrow({ where: { id } });
  });
}

const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  ACTIVE: ["ON_HOLD", "COMPLETED", "ARCHIVED"],
  ON_HOLD: ["ACTIVE", "COMPLETED", "ARCHIVED"],
  COMPLETED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: ["ACTIVE"],
};

export async function changeProjectStatus(actor: Actor, id: string, body: unknown) {
  const b = z.object({ to: z.enum(["ACTIVE", "ON_HOLD", "COMPLETED", "ARCHIVED"]), reason: z.string().nullish(), overrideOpenTasks: z.boolean().optional() }).parse(body);
  return runTx(async (tx) => {
    const p = await tx.project.findUnique({ where: { id } });
    if (!p) throw fail.notFound("Project");
    assertCan(actor, "MANAGE_PROJECTS", p.ownerId === actor.id);
    if (!PROJECT_TRANSITIONS[p.status].includes(b.to)) throw fail.transition(p.status, b.to);
    const reason = b.reason?.trim();
    if (b.to === "COMPLETED" || b.to === "ARCHIVED") {
      const open = await tx.task.count({ where: { projectId: id, softDeleted: false, status: { in: ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"] } } });
      const policy = (await getConfig("projects", tx)).allowCompleteWithOpenTasks;
      // Project closure never completes its tasks (§35.5); it either waits for them or records an explicit override.
      if (open > 0) {
        if (policy === "NEVER" || !b.overrideOpenTasks) throw fail.blocked(`${open} linked task(s) are still active.`, { openTasks: open });
        if (!reason) throw fail.validation({ reason: "A reason is required to close a project with active tasks." });
      }
    }
    if ((b.to === "ARCHIVED" || p.status === "ARCHIVED") && !reason) throw fail.validation({ reason: "A reason is required." });
    await tx.project.update({ where: { id }, data: { status: b.to, closureNote: reason ?? p.closureNote, version: { increment: 1 }, updatedById: actor.id } });
    await audit(tx, { recordId: id, entityType: "PROJECT", eventType: "PROJECT_STATUS_CHANGED", actor, previousValue: p.status, newValue: b.to, reason });
    return { ok: true };
  });
}

const milestoneSchema = z.object({ name: z.string(), ownerId: z.string(), targetDate: z.string(), weight: z.number().positive().optional(), status: z.enum(["PLANNED", "IN_PROGRESS", "DONE", "MISSED"]).optional() });

export async function upsertMilestone(actor: Actor, projectId: string, milestoneId: string | null, body: unknown) {
  const b = milestoneSchema.parse(body);
  return runTx(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: projectId } });
    if (!p) throw fail.notFound("Project");
    assertCan(actor, "MANAGE_PROJECTS", p.ownerId === actor.id);
    if (p.status === "ARCHIVED") throw fail.blocked("Archived projects are read-only.");
    const errors: Record<string, string> = {};
    if (!b.name.trim()) errors.name = "Name is required.";
    if (!(await tx.user.findFirst({ where: { id: b.ownerId, status: "ACTIVE" } }))) errors.ownerId = "Pick an active owner.";
    const d = tryParseISODate(b.targetDate);
    if (!d) errors.targetDate = "Enter a valid date.";
    if (Object.keys(errors).length) throw fail.validation(errors);
    const data = { name: b.name.trim(), ownerId: b.ownerId, targetDate: d!, weight: b.weight ?? 1, status: (b.status ?? "PLANNED") as MilestoneStatus, completedAt: b.status === "DONE" ? new Date() : null };
    const m = milestoneId
      ? await tx.milestone.update({ where: { id: milestoneId, projectId }, data })
      : await tx.milestone.create({ data: { ...data, projectId } });
    await audit(tx, { recordId: projectId, entityType: "PROJECT", eventType: milestoneId ? "MILESTONE_UPDATED" : "MILESTONE_CREATED", actor, relatedEntityId: m.id, newValue: { ...data, targetDate: iso(d) } });
    return m;
  });
}

// Eligible = linked, not binned, not excluded by the gate, not dropped. Each recurring occurrence counts once.
export async function projectRollups(actor: Actor) {
  const projects = await prisma.project.findMany({ include: { owner: { select: { id: true, name: true } }, milestones: true }, orderBy: [{ status: "asc" }, { name: "asc" }] });
  const tasks = await prisma.task.findMany({ where: { projectId: { not: null }, softDeleted: false, excludedFromMetrics: false, status: { not: "DROPPED" } }, select: { projectId: true, status: true, deadline: true, escalationRequired: true } });
  const today = todayBiz();
  return projects.map((p) => {
    const ts = tasks.filter((t) => t.projectId === p.id);
    const completed = ts.filter((t) => t.status === "COMPLETED").length;
    const wTotal = p.milestones.reduce((s, m) => s + Number(m.weight), 0);
    const wDone = p.milestones.filter((m) => m.status === "DONE").reduce((s, m) => s + Number(m.weight), 0);
    return {
      id: p.id, name: p.name, description: p.description, status: p.status, owner: p.owner, channels: p.channels,
      startDate: iso(p.startDate), targetDate: iso(p.targetDate), version: p.version,
      total: ts.length, completed, active: ts.filter((t) => isActive(t.status)).length,
      notStarted: ts.filter((t) => t.status === "NOT_STARTED").length,
      overdue: ts.filter((t) => isActive(t.status) && today > t.deadline).length,
      escalated: ts.filter((t) => isActive(t.status) && t.escalationRequired).length,
      taskCompletionPct: ts.length ? Math.round((completed / ts.length) * 100) : null,
      milestoneProgressPct: wTotal ? Math.round((wDone / wTotal) * 100) : null,
      canManage: can(actor, "MANAGE_PROJECTS", p.ownerId === actor.id),
    };
  });
}

export async function projectDetail(actor: Actor, id: string) {
  const p = await prisma.project.findUnique({ where: { id }, include: { owner: { select: { id: true, name: true } }, milestones: { include: { owner: { select: { name: true } } }, orderBy: { targetDate: "asc" } } } });
  if (!p) throw fail.notFound("Project");
  const rollup = (await projectRollups(actor)).find((r) => r.id === id)!;
  // Task list honours task-level visibility; aggregate counts above do not expose task content.
  const tasks = await prisma.task.findMany({ where: { projectId: id, softDeleted: false, ...visibleWhere(actor) }, include: taskInclude, orderBy: [{ status: "asc" }, { deadline: "asc" }] });
  const dtos = tasks.map((t) => toDTO(t, undefined, actor));
  const by = (key: (t: (typeof dtos)[number]) => string) => dtos.reduce<Record<string, number>>((acc, t) => ((acc[key(t)] = (acc[key(t)] ?? 0) + 1), acc), {});
  return {
    project: { ...p, startDate: iso(p.startDate), targetDate: iso(p.targetDate), milestones: p.milestones.map((m) => ({ ...m, weight: Number(m.weight), targetDate: iso(m.targetDate) })) },
    rollup,
    tasks: dtos,
    byOwner: by((t) => t.owner.name),
    byChannel: by((t) => t.channel.name),
    contributors: [...new Set(dtos.map((t) => t.owner.name))],
    upcoming: dtos.filter((t) => isActive(t.status)).slice(0, 10),
    recentlyUpdated: [...dtos].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10),
  };
}
