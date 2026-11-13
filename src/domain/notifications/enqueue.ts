import type { Tx } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getConfig } from "@/lib/config";
import { loadActor } from "../actor";
import { canSeeTask } from "../task-core";
import { liveSignal } from "@/lib/live";

export type EventType =
  | "TASK_ASSIGNED"
  | "PRIORITY_CHANGED"
  | "DEADLINE_CHANGED"
  | "STATUS_CHANGED"
  | "POC_CHANGED"
  | "SUBTASK_ASSIGNED"
  | "TRANSFER_REQUESTED"
  | "TRANSFER_DECIDED"
  | "EXTENSION_REQUESTED"
  | "EXTENSION_DECIDED"
  | "WAIVER_REQUESTED"
  | "WAIVER_DECIDED"
  | "CANCELLATION_REQUESTED"
  | "ESCALATION_TRIGGERED"
  | "ESCALATION_REASSIGNED"
  | "ESCALATION_RESOLVED"
  | "TASK_STARRED"
  | "TASK_BINNED"
  | "TASK_RESTORED"
  | "POC_PROMOTION_REQUESTED"
  | "POC_PROMOTION_DECIDED"
  | "SERIES_EXCEPTION"
  | "MORNING_DIGEST_PERSONAL"
  | "EXECUTIVE_DIGEST";

// Event → channel matrix (brief §14, Addendum A3). Proposed defaults; awaiting sign-off (see docs/NOTIFICATIONS.md).
export const CHANNELS: Record<EventType, { inApp: boolean; email: boolean; label: string }> = {
  TASK_ASSIGNED: { inApp: true, email: true, label: "Task assigned to you" },
  PRIORITY_CHANGED: { inApp: true, email: true, label: "Priority changed" },
  DEADLINE_CHANGED: { inApp: true, email: true, label: "Deadline changed" },
  STATUS_CHANGED: { inApp: true, email: false, label: "Status changed" },
  POC_CHANGED: { inApp: true, email: false, label: "Pending From changed" },
  SUBTASK_ASSIGNED: { inApp: true, email: false, label: "Subtask assigned" },
  TRANSFER_REQUESTED: { inApp: true, email: true, label: "Transfer awaiting your response" },
  TRANSFER_DECIDED: { inApp: true, email: false, label: "Transfer decided" },
  EXTENSION_REQUESTED: { inApp: true, email: true, label: "Extension request" },
  EXTENSION_DECIDED: { inApp: true, email: true, label: "Extension decision" },
  WAIVER_REQUESTED: { inApp: true, email: true, label: "Waiver request" },
  WAIVER_DECIDED: { inApp: true, email: true, label: "Waiver decision" },
  CANCELLATION_REQUESTED: { inApp: true, email: false, label: "Cancellation request" },
  ESCALATION_TRIGGERED: { inApp: true, email: true, label: "Escalation raised" },
  ESCALATION_REASSIGNED: { inApp: true, email: true, label: "Escalation reassigned" },
  ESCALATION_RESOLVED: { inApp: true, email: false, label: "Escalation resolved" },
  TASK_STARRED: { inApp: true, email: false, label: "Task starred" },
  TASK_BINNED: { inApp: true, email: false, label: "Task moved to Bin" },
  TASK_RESTORED: { inApp: true, email: false, label: "Task restored" },
  POC_PROMOTION_REQUESTED: { inApp: true, email: false, label: "POC awaiting registry approval" },
  POC_PROMOTION_DECIDED: { inApp: true, email: false, label: "POC registry decision" },
  SERIES_EXCEPTION: { inApp: true, email: false, label: "Recurring series needs attention" },
  MORNING_DIGEST_PERSONAL: { inApp: false, email: true, label: "Daily focus" },
  EXECUTIVE_DIGEST: { inApp: false, email: true, label: "Executive summary" },
};

export interface EnqueueInput {
  eventType: EventType;
  // Stable transition identity — the idempotency key. Never a bare timestamp.
  transitionId: string;
  taskId?: string | null;
  recipientIds: string[];
  // In-app title. Email subjects are built from eventType + task ID only (no task details on lock screens).
  subject: string;
  payload: Record<string, unknown>;
  actorId?: string | null;
}

export const emailSubject = (eventType: EventType, taskId?: string | null) => `[Palmonas] ${CHANNELS[eventType].label}${taskId ? ` · ${taskId}` : ""}`;

// Recipients are filtered to people who can currently see the task, so no notification leaks a task
// to someone without access. The rows commit atomically with the business change (transactional outbox).
export async function enqueue(tx: Tx, e: EnqueueInput) {
  const chan = CHANNELS[e.eventType];
  const dedupKey = `${e.eventType}:${e.taskId ?? "-"}:${e.transitionId}`;
  const ids = [...new Set(e.recipientIds.filter(Boolean))].filter((id) => id !== e.actorId);
  const allowed: string[] = [];
  for (const id of ids) {
    const a = await loadActor(id, tx);
    if (!a) continue;
    if (e.taskId && !(await canSeeTask(tx, a, e.taskId))) continue;
    allowed.push(id);
  }
  if (!allowed.length) return;
  if (chan.inApp) {
    const body = typeof e.payload.reason === "string" ? e.payload.reason.slice(0, 300) : "";
    await tx.inAppNotification.createMany({
      data: allowed.map((userId) => ({ userId, taskId: e.taskId ?? null, eventType: e.eventType, title: e.subject, body, dedupKey })),
      skipDuplicates: true,
    });
    for (const userId of allowed) await liveSignal(tx, { kind: "bell", userId });
  }
  if (chan.email) {
    // Email gate (Addendum A, implementation gate): while delivery is off, events are recorded as SKIPPED
    // instead of queued, so switching email on later never flushes a historical backlog.
    const { emailDelivery } = await getConfig("notifications", tx);
    await tx.notificationEvent.createMany({
      data: allowed.map((recipientId) => ({
        dedupKey, eventType: e.eventType, taskId: e.taskId ?? null, recipientId, subject: emailSubject(e.eventType, e.taskId),
        payload: { ...e.payload, title: e.subject } as Prisma.InputJsonValue,
        ...(emailDelivery === "OFF" ? { status: "SKIPPED" as const, errorCategory: "EMAIL_OFF", error: "Email delivery is switched off in Settings" } : {}),
      })),
      skipDuplicates: true,
    });
  }
}

export async function governanceRecipients(tx: Tx, tiers: ("ADMIN" | "LEADERSHIP")[] = ["ADMIN", "LEADERSHIP"]) {
  const users = await tx.user.findMany({ where: { role: { tier: { in: tiers } }, status: "ACTIVE" }, select: { id: true } });
  return users.map((u) => u.id);
}
