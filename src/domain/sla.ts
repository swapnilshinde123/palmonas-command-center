import type { TaskStatus } from "@prisma/client";
import { businessDateOf, diffDays } from "@/lib/dates";

export const ACTIVE_STATUSES: TaskStatus[] = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"];
export const TERMINAL_STATUSES: TaskStatus[] = ["COMPLETED", "DROPPED"];
export const isActive = (s: TaskStatus) => ACTIVE_STATUSES.includes(s);

export type Timeliness = "ON_TIME" | "LATE" | "IN_PROGRESS" | "OVERDUE" | "DROPPED";

export const TIMELINESS_LABEL: Record<Timeliness, string> = {
  ON_TIME: "On-Time / Early",
  LATE: "Completed Late",
  IN_PROGRESS: "In Progress",
  OVERDUE: "Overdue",
  DROPPED: "Dropped",
};

interface SlaInput {
  status: TaskStatus;
  assignedDate: Date;
  deadline: Date;
  completedAt: Date | null;
}

// Decisions (DEC-007, §11.3): calendar-date comparison in business TZ; completing ON the deadline is
// on time; overdue = active and today > operative deadline; a completed task is never "Overdue",
// it is "Completed Late"; aging continues while ON_HOLD.
export function timeliness(t: SlaInput, today: Date): Timeliness {
  if (t.status === "DROPPED") return "DROPPED";
  if (t.status === "COMPLETED") {
    const done = t.completedAt ? businessDateOf(t.completedAt) : today;
    return done.getTime() <= t.deadline.getTime() ? "ON_TIME" : "LATE";
  }
  return today.getTime() > t.deadline.getTime() ? "OVERDUE" : "IN_PROGRESS";
}

export function agingDays(t: SlaInput, today: Date): number | null {
  if (t.status === "DROPPED") return null;
  const end = t.status === "COMPLETED" && t.completedAt ? businessDateOf(t.completedAt) : today;
  return Math.max(0, diffDays(end, t.assignedDate));
}

export function tatDays(t: SlaInput): number | null {
  if (t.status !== "COMPLETED" || !t.completedAt) return null;
  return Math.max(0, diffDays(businessDateOf(t.completedAt), t.assignedDate));
}

export function daysOverdue(t: SlaInput, today: Date): number {
  if (!isActive(t.status)) return 0;
  return Math.max(0, diffDays(today, t.deadline));
}
