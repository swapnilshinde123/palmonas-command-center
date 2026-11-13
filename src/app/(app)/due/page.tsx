"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useApi } from "@/components/client";
import { useUrlState } from "@/components/useUrlState";
import { useWorkspace, type Task } from "@/components/workspace";
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { TaskTable } from "@/components/tasks/TaskTable";

type Due = { view: string; windows: { deadlineDays: number; followupDays: number }; today: string; tasks: (Task & { reasons: string[] })[]; seriesFollowups: { seriesId: string; title: string; owner: string; date: string | null; kind: string; note: string | null }[] };

export default function DuePage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><DueSoon /></Suspense>;
}

function DueSoon() {
  const { ws } = useWorkspace();
  const [f, set] = useUrlState(["view", "reason"] as const);
  const { data, error, isLoading, mutate } = useApi<Due>(`/due${f.view ? `?view=${f.view}` : ""}`);
  const reason = f.reason || "all";
  const rows = (data?.tasks ?? []).filter((t) => reason === "all" || (reason === "deadline" ? t.reasons.some((r) => r === "Overdue" || r.startsWith("Deadline")) : t.reasons.some((r) => r.startsWith("Follow-up"))));
  const count = (k: string) => (data?.tasks ?? []).filter((t) => (k === "deadline" ? t.reasons.some((r) => r === "Overdue" || r.startsWith("Deadline")) : t.reasons.some((r) => r.startsWith("Follow-up")))).length;
  const tone = (r: string) => (r === "Overdue" || r === "Follow-up overdue" ? "red" : r.startsWith("Deadline") ? "amber" : "violet") as "red" | "amber" | "violet";

  return (
    <div className="space-y-6">
      <PageHeader description={data ? `Deadlines in the next ${data.windows.deadlineDays} days and follow-ups in the next ${data.windows.followupDays} days. Overdue work stays here until it's done.` : undefined} />
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Segmented label="Reason" value={reason} onChange={(v) => set({ reason: v === "all" ? null : v })} options={[{ value: "all", label: "Everything", count: data?.tasks.length }, { value: "deadline", label: "Deadlines", count: count("deadline") }, { value: "followup", label: "Follow-ups", count: count("followup") }]} />
        {ws?.privileged && <Segmented label="Whose" value={f.view || "mine"} onChange={(v) => set({ view: v === "mine" ? null : v })} options={[{ value: "mine", label: "Mine" }, { value: "team", label: "Whole team" }]} />}
      </div>
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      <Card>
        {isLoading && !data ? <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          : rows.length === 0 ? <EmptyState icon="checkCircle" title="Nothing due soon" body="No deadlines or follow-ups in the window. Nice." />
          : <TaskTable rows={rows} extraLabel="Why it's here" extra={(t) => <div className="flex flex-wrap gap-1">{t.reasons.map((r) => <Badge key={r} tone={tone(r)}>{r}</Badge>)}</div>} hideOwner={data?.view === "mine"} />}
      </Card>
      {data && data.seriesFollowups.length > 0 && (
        <Card>
          <CardHeader title="Recurring follow-ups" subtitle="Skipped occurrences and paused series need a next action on these dates." />
          <ul className="divide-y divide-slate-100 text-sm">
            {data.seriesFollowups.map((s, i) => (
              <li key={i} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div><Link href="/recurring" className="font-semibold hover:text-brand">{s.title}</Link><p className="text-xs text-slate-500">{s.kind}{s.note ? ` · ${s.note}` : ""} · {s.owner}</p></div>
                <Badge tone={s.date && s.date < data.today ? "red" : "violet"}>{s.date}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
