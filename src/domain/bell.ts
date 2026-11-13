import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Actor } from "./actor";
import { canSeeTask } from "./task-core";

export async function listBell(actor: Actor, raw: unknown) {
  const f = z.object({ unread: z.string().optional() }).parse(raw ?? {});
  const [rows, unread] = await Promise.all([
    prisma.inAppNotification.findMany({ where: { userId: actor.id, ...(f.unread === "true" ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.inAppNotification.count({ where: { userId: actor.id, readAt: null } }),
  ]);
  // Re-check access at read time: a notification for a task the person can no longer see shows no task link.
  const out = await Promise.all(rows.map(async (n) => ({
    id: n.id, eventType: n.eventType, title: n.taskId && !(await canSeeTask(prisma, actor, n.taskId)) ? "A task you no longer have access to was updated" : n.title,
    body: n.taskId && !(await canSeeTask(prisma, actor, n.taskId)) ? "" : n.body,
    taskId: n.taskId && (await canSeeTask(prisma, actor, n.taskId)) ? n.taskId : null,
    read: !!n.readAt, createdAt: n.createdAt.toISOString(),
  })));
  return { rows: out, unread };
}

export async function markRead(actor: Actor, raw: unknown) {
  const b = z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }).parse(raw ?? {});
  const r = await prisma.inAppNotification.updateMany({ where: { userId: actor.id, readAt: null, ...(b.all ? {} : { id: { in: b.ids ?? [] } }) }, data: { readAt: new Date() } });
  return { updated: r.count };
}
