import type { Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { z } from "zod";
import { assertCan, type Actor } from "./actor";

export interface ActivityInput {
  actor: Pick<Actor, "id" | "name"> | null;
  action: string;
  targetType: "USER" | "INVITATION" | "ROLE" | "AUTH" | "SYSTEM";
  targetId?: string | null;
  targetLabel?: string;
  meta?: Record<string, unknown>;
}

// Written in the same transaction as the change: if logging fails the change rolls back.
export async function logActivity(tx: Tx, e: ActivityInput) {
  await tx.activityLog.create({
    data: {
      actorId: e.actor?.id ?? null,
      actorName: e.actor?.name ?? "System",
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      targetLabel: e.targetLabel ?? "",
      meta: e.meta ? (JSON.parse(JSON.stringify(e.meta)) as Prisma.InputJsonValue) : undefined,
    },
  });
}

export const ACTION_LABEL: Record<string, string> = {
  "user.created": "added user",
  "user.updated": "updated user",
  "user.role_changed": "changed role of",
  "user.status_changed": "changed status of",
  "user.deleted": "deleted user",
  "user.escalation_level_changed": "changed escalation level of",
  "auth.google_login": "signed in with Google",
  "user.password_changed": "changed password",
  "invitation.sent": "invited",
  "invitation.resent": "resent invitation to",
  "invitation.revoked": "revoked invitation for",
  "invitation.accepted": "accepted invitation",
  "role.created": "created role",
  "role.updated": "updated role",
  "role.deleted": "deleted role",
  "auth.login": "signed in",
  "auth.login_failed": "failed sign-in for",
  "auth.locked": "locked account after failed sign-ins:",
};

export async function listActivity(actor: Actor, raw: unknown) {
  assertCan(actor, "activity.view");
  const f = z.object({ q: z.string().optional(), type: z.string().optional(), page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(5).max(100).optional() }).parse(raw ?? {});
  const pageSize = f.pageSize ?? 25;
  const where: Prisma.ActivityLogWhereInput = {
    ...(f.type ? { targetType: f.type } : {}),
    ...(f.q ? { OR: [{ actorName: { contains: f.q, mode: "insensitive" } }, { targetLabel: { contains: f.q, mode: "insensitive" } }, { action: { contains: f.q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.activityLog.findMany({ where, orderBy: { seq: "desc" }, skip: ((f.page ?? 1) - 1) * pageSize, take: pageSize }),
    prisma.activityLog.count({ where }),
  ]);
  return { rows: rows.map((r) => ({ ...r, seq: Number(r.seq), label: ACTION_LABEL[r.action] ?? r.action })), total, page: f.page ?? 1, pageSize };
}
