"use client";
import Link from "next/link";
import { Badge, cx, fmtDate, Icon } from "@/components/ui";
import { POC_LABEL, type PocType, type Task } from "@/components/workspace";

export const STATUS: Record<string, { label: string; tone: "slate" | "blue" | "amber" | "green" | "red" }> = {
  NOT_STARTED: { label: "Not started", tone: "slate" },
  IN_PROGRESS: { label: "In progress", tone: "blue" },
  ON_HOLD: { label: "On hold", tone: "amber" },
  COMPLETED: { label: "Completed", tone: "green" },
  DROPPED: { label: "Dropped", tone: "slate" },
};

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS[status]?.tone ?? "slate"} dot>{STATUS[status]?.label ?? status}</Badge>;

export function PriorityBadge({ p }: { p: number }) {
  const tone = p === 0 ? "bg-red-600 text-white" : p <= 2 ? "bg-orange-100 text-orange-800" : p <= 4 ? "bg-slate-100 text-slate-700" : "bg-slate-50 text-slate-500";
  return <span className={cx("inline-grid h-6 min-w-9 place-items-center rounded-md px-1.5 text-xs font-extrabold tabular", tone)} title={`Priority P${p}`}>P{p}</span>;
}

const POC_TONE: Record<PocType, string> = { I: "bg-sky-50 text-sky-800 ring-sky-600/20", WB: "bg-violet-50 text-violet-800 ring-violet-600/20", E: "bg-amber-50 text-amber-900 ring-amber-600/25" };
export function PocBadge({ type, name, compact }: { type: PocType; name?: string | null; compact?: boolean }) {
  return (
    <span className={cx("inline-flex h-6 max-w-full items-center gap-1 truncate rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset", POC_TONE[type])} title={`${POC_LABEL[type]}${name ? `: ${name}` : ""}`}>
      <span className="font-bold">{compact ? type : POC_LABEL[type]}</span>{name && <span className="truncate font-medium">· {name}</span>}
    </span>
  );
}

export function LevelBadge({ level }: { level: string }) {
  if (!level || level === "L0") return <span className="text-xs font-semibold text-slate-400">L0</span>;
  const tone = level === "L3" ? "bg-red-600 text-white" : level === "L2" ? "bg-orange-500 text-white" : "bg-amber-400 text-amber-950";
  return <span className={cx("inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-extrabold", tone)}><Icon name="flame" size={13} />{level}</span>;
}

export function DeadlineText({ t }: { t: Pick<Task, "deadline" | "timeliness" | "daysOverdue" | "status"> }) {
  const overdue = t.timeliness === "OVERDUE";
  return (
    <span className={cx("whitespace-nowrap text-sm tabular", overdue ? "font-bold text-red-600" : "text-slate-700")}>
      {fmtDate(t.deadline, { day: "numeric", month: "short" })}
      {overdue && <span className="ml-1 text-xs">({t.daysOverdue}d late)</span>}
    </span>
  );
}

export function TaskTitle({ t, href = true }: { t: Pick<Task, "id" | "name" | "flagged" | "starred">; href?: boolean }) {
  const body = (
    <>
      <span className="flex items-center gap-1.5">
        {t.flagged && <Icon name="flag" size={14} className="flex-none text-red-600" label="Flagged" />}
        {t.starred && <Icon name="star" size={14} className="flex-none text-amber-500" label="Starred" />}
        <span className="truncate font-semibold text-slate-900">{t.name}</span>
      </span>
      <span className="block text-xs text-slate-500 tabular">{t.id}</span>
    </>
  );
  return href ? <Link href={`/tasks/${encodeURIComponent(t.id)}`} className="block min-w-0 hover:[&_span.font-semibold]:text-brand">{body}</Link> : <div className="min-w-0">{body}</div>;
}

export const EVENT_LABEL: Record<string, string> = {
  TASK_CREATED: "created the task", TASK_UPDATED: "edited details", PRIORITY_CHANGED: "changed priority", DEADLINE_CHANGED: "changed the deadline",
  DEADLINE_CORRECTED: "corrected the deadline", STATUS_CHANGED: "changed status", TASK_COMPLETED: "completed the task", TASK_REOPENED: "reopened the task",
  TASK_DROPPED: "dropped the task", TRANSFER_REQUESTED: "requested a transfer", TRANSFER_ACCEPTED: "accepted the transfer", TRANSFER_REJECTED: "rejected the transfer",
  TRANSFER_CANCELLED: "withdrew the transfer", OWNER_CHANGED: "changed the owner", EXTENSION_REQUESTED: "requested an extension", EXTENSION_APPROVED: "approved the extension",
  EXTENSION_REJECTED: "rejected the extension", WAIVER_REQUESTED: "requested a waiver", WAIVER_APPROVED: "approved the waiver", WAIVER_REJECTED: "rejected the waiver",
  ESCALATION_TRIGGERED: "escalated the task", ESCALATION_REASSIGNED: "reassigned the escalation", ESCALATION_RESOLVED: "resolved the escalation", ESCALATION_UPDATE: "posted an escalation update",
  TASK_SOFT_DELETED: "moved the task to the Bin", TASK_RESTORED: "restored the task", TASK_HARD_DELETED: "purged the task", TASK_PURGE_DENIED: "tried to purge (denied)",
  TASK_FLAGGED: "flagged the task", TASK_UNFLAGGED: "removed the flag", TASK_STARRED: "starred the task", TASK_UNSTARRED: "unstarred the task",
  POC_CHANGED: "updated Pending From", POC_CLEARED: "cleared Pending From", POC_PROMOTION_REQUESTED: "asked L1 to add the POC to the registry", POC_PROMOTED: "added the POC to the registry",
  POC_PROMOTION_REJECTED: "declined the POC for the registry", KPI_ADJUSTMENT: "recorded a KPI adjustment", ACCESS_GRANTED: "shared the task", ACCESS_REVOKED: "removed someone's access",
  CANCELLATION_REQUESTED: "asked to drop/remove the task", CANCELLATION_APPROVED: "approved the drop/remove request", CANCELLATION_REJECTED: "rejected the drop/remove request",
  P0_JUSTIFIED: "justified P0", SUBTASK_CREATED: "added a subtask", TASK_IMPORTED: "imported the task",
};
