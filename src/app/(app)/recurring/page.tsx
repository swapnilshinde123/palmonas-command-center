"use client";
import Link from "next/link";
import { useState } from "react";
import type { listSeries } from "@/domain/recurrence";
import { api, refreshAll, useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, EmptyState, fmtDate, Menu, PageHeader, Skeleton } from "@/components/ui";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { StatusBadge } from "@/components/tasks/bits";
import { toast } from "@/components/toast";

type S = Awaited<ReturnType<typeof listSeries>>[number];
const CAD: Record<string, string> = { DAILY: "Daily", WEEKLY: "Weekly", BIWEEKLY: "Every 2 weeks", MONTHLY: "Monthly" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export default function RecurringPage() {
  const { data, error, isLoading, mutate } = useApi<S[]>("/series");
  const { data: me } = useMe();
  const { ws } = useWorkspace();
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const act = (s: S, action: string, body: Record<string, unknown> = {}) => api(`/series/${s.id}/action`, { body: { action, ...body } }).then(refreshAll);

  const create = () => setSpec({
    title: "New recurring task", submitLabel: "Create series", description: "A new task is created for each occurrence.",
    fields: [
      { name: "title", label: "Title", required: true },
      { name: "channelId", label: "Channel", type: "select", required: true, options: (ws?.channels ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: c.name })) },
      { name: "ownerId", label: "Owner", type: "select", required: true, options: (ws?.users ?? []).map((u) => ({ value: u.id, label: u.name })) },
      { name: "priority", label: "Priority", type: "select", required: true, options: Array.from({ length: 6 }, (_, i) => ({ value: String(i), label: `P${i}` })) },
      { name: "cadence", label: "Repeats", type: "radio", required: true, options: [{ value: "DAILY", label: "Daily" }, { value: "WEEKLY", label: "Weekly" }, { value: "MONTHLY", label: "Monthly" }] },
      { name: "weekday", label: "On", type: "select", required: true, options: DAYS.map((d, i) => ({ value: String(i), label: d })), showIf: (v) => v.cadence === "WEEKLY" },
      { name: "workingDaysOnly", label: "Working days only", type: "checkbox", hint: "Skip weekends and company holidays.", showIf: (v) => v.cadence === "DAILY" },
      { name: "startDate", label: "Starts", type: "date", required: true, min: today() },
      { name: "deadlineOffsetDays", label: "Days to complete each occurrence", placeholder: "0 = same day" },
    ],
    initial: { ownerId: me?.me.id ?? "", priority: "3", cadence: "DAILY", startDate: today(), deadlineOffsetDays: "0" },
    run: async (v) => {
      await api("/series", { body: { title: v.title, channelId: v.channelId, ownerId: v.ownerId, priority: Number(v.priority), cadence: v.cadence, weekdays: v.cadence === "WEEKLY" ? [Number(v.weekday)] : undefined, workingDaysOnly: v.workingDaysOnly === true, startDate: v.startDate, deadlineOffsetDays: Number(v.deadlineOffsetDays || 0) } });
      await refreshAll(); toast.success("Recurring task created");
    },
  });
  const skip = (s: S) => setSpec({
    title: "Skip an occurrence", submitLabel: "Skip occurrence", description: s.title, intro: "A follow-up date is required so the skipped work isn't forgotten. It appears in Due Soon.",
    fields: [{ name: "date", label: "Occurrence to skip", type: "date", required: true, min: today() }, { name: "reason", label: "Reason", type: "textarea", required: true }, { name: "followupDate", label: "Follow-up date", type: "date", required: true, min: today() }],
    initial: { date: s.nextOccurrenceDate ?? "" },
    run: async (v) => { await act(s, "SKIP", v); toast.success("Occurrence skipped", `Follow up on ${v.followupDate}.`); },
  });
  const pause = (s: S) => setSpec({
    title: "Pause series", submitLabel: "Pause", description: s.title, intro: "No new occurrences are created while paused. Pick a date to resume or review it; it shows in Due Soon.",
    fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }, { name: "followupDate", label: "Resume / follow-up date", type: "date", required: true, min: today() }],
    run: async (v) => { await act(s, "PAUSE", v); toast.success("Series paused", `Review on ${v.followupDate}.`); },
  });
  const end = (s: S) => setSpec({ title: "End series", submitLabel: "End series", danger: true, description: s.title, intro: "Existing tasks stay. No new occurrences are created.", fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }], run: async (v) => { await act(s, "END", v); toast.success("Series ended"); } });

  return (
    <div className="space-y-6">
      <PageHeader description="Repeating work. Skipping or pausing always needs a follow-up date." actions={<Button variant="primary" icon="plus" onClick={create}>New recurring task</Button>} />
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      {isLoading && !data ? <Skeleton className="h-64 rounded-2xl" /> : !data?.length ? <Card><EmptyState icon="repeat" title="No recurring tasks" action={<Button icon="plus" onClick={create}>New recurring task</Button>} /></Card> : (
        <div className="space-y-3">
          {data.map((s) => (
            <Card key={s.id} as="article" className="p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><h2 className="font-bold">{s.title}</h2><Badge tone={s.status === "ACTIVE" ? "green" : s.status === "PAUSED" ? "amber" : "slate"}>{s.status.toLowerCase()}</Badge>{s.exceptions.length > 0 && <Badge tone="red" icon="alert">{s.exceptions.length} need attention</Badge>}</div>
                  <p className="text-sm text-slate-500">{CAD[s.cadence]}{s.weekdays.length ? ` on ${s.weekdays.map((d) => DAYS[d]).join(", ")}` : ""}{s.workingDaysOnly ? ", working days" : ""} · {s.channel.name} · {s.owner.name} · P{s.priority}</p>
                  <p className="text-sm text-slate-500">{s.status === "PAUSED" ? <>Paused{s.pauseReason ? `: ${s.pauseReason}` : ""} · <b className="text-amber-700">review {fmtDate(s.resumeDate)}</b></> : s.nextOccurrenceDate ? `Next: ${fmtDate(s.nextOccurrenceDate)}` : "No upcoming occurrence"}</p>
                  {s.skips.filter((k) => (k.date ?? "") >= today()).length > 0 && <p className="text-xs text-slate-500">Skipped: {s.skips.map((k) => `${fmtDate(k.date, { day: "numeric", month: "short" })} (follow up ${fmtDate(k.followupDate, { day: "numeric", month: "short" })})`).join(", ")}</p>}
                  {s.exceptions.map((e) => <p key={e.id} className="mt-1 text-xs text-red-700">{e.kind.replace(/_/g, " ").toLowerCase()}: {e.detail}</p>)}
                  {s.tasks.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{s.tasks.slice(0, 6).map((t) => <Link key={t.id} href={`/tasks/${encodeURIComponent(t.id)}`} className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1 text-xs hover:bg-brand-soft"><span className="tabular">{fmtDate(t.scheduledDate, { day: "numeric", month: "short" })}</span><StatusBadge status={t.status} /></Link>)}</div>}
                </div>
                {s.canManage && s.status !== "ENDED" && (
                  <Menu label={`Actions for ${s.title}`} items={[
                    s.status === "ACTIVE" ? { label: "Skip an occurrence", icon: "chevronRight", onSelect: () => skip(s) } : null,
                    s.status === "ACTIVE" ? { label: "Pause", icon: "pause", onSelect: () => pause(s) } : { label: "Resume", icon: "play", onSelect: () => act(s, "RESUME").then(() => toast.success("Series resumed")) },
                    ...s.exceptions.map((e) => ({ label: `Mark resolved: ${e.kind.replace(/_/g, " ").toLowerCase()}`, icon: "check" as const, onSelect: () => act(s, "RESOLVE_EXCEPTION", { exceptionId: e.id }) })),
                    { label: "End series", icon: "ban", danger: true, onSelect: () => end(s) },
                  ]} />
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}
