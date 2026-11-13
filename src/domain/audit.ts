import type { Tx } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { Actor } from "./rbac";
import { liveSignal } from "@/lib/live";

export interface AuditInput {
  recordId: string;
  entityType?: "TASK" | "SUBTASK" | "PROJECT" | "SERIES" | "USER" | "CONFIG" | "SCORECARD" | "NOTIFICATION" | "SYSTEM";
  eventType: string;
  actor: Actor | null; // null = automated process
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  requestId?: string | null;
  relatedEntityId?: string | null;
  result?: "SUCCESS" | "REJECTED" | "FAILED" | "PARTIAL";
}

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

// Always called inside the same transaction as the business write: if audit fails, the action rolls back (DEC-014).
export async function audit(tx: Tx, e: AuditInput) {
  await tx.auditEvent.create({
    data: {
      recordId: e.recordId,
      entityType: e.entityType ?? "TASK",
      eventType: e.eventType,
      actorId: e.actor?.id ?? null,
      actorName: e.actor?.name ?? "system",
      previousValue: json(e.previousValue),
      newValue: json(e.newValue),
      reason: e.reason ?? null,
      requestId: e.requestId ?? null,
      relatedEntityId: e.relatedEntityId ?? null,
      result: e.result ?? "SUCCESS",
    },
  });
  if ((e.entityType ?? "TASK") === "TASK") await liveSignal(tx, { kind: "task", taskId: e.recordId.replace(/-S\d+$/, "") });
  else await liveSignal(tx, { kind: "admin" });
}

export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const prev: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const a = before[k];
    const b = after[k];
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    if (JSON.stringify(norm(a)) !== JSON.stringify(norm(b))) {
      prev[k] = norm(a) ?? null;
      next[k] = norm(b) ?? null;
    }
  }
  return { prev, next, changed: Object.keys(next) };
}
