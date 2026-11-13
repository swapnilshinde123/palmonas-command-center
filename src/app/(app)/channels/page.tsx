"use client";
import { Suspense } from "react";
import { useApi } from "@/components/client";
import { useUrlState } from "@/components/useUrlState";
import type { Task } from "@/components/workspace";
import { Card, CardHeader, cx, EmptyState, Icon, PageHeader, Skeleton } from "@/components/ui";
import { TaskTable } from "@/components/tasks/TaskTable";

type Bucket = { key: string; label: string; active: number; overdue: number; dueSoon: number; onHold: number; completedThisMonth: number };

export default function ChannelsPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Channels /></Suspense>;
}

// Team-wide counts per channel are visible to everyone; the task list below only ever contains
// tasks the viewer can open (brief §11).
function Channels() {
  const [f, set] = useUrlState(["channelId"] as const);
  const { data } = useApi<{ drilldown: boolean; channels: Bucket[] }>("/channels");
  const sel = data?.channels.find((c) => c.key === f.channelId) ?? data?.channels[0];
  const { data: tasks, isLoading } = useApi<Task[]>(sel ? `/tasks?view=${data?.drilldown ? "team" : "all"}&channelId=${sel.key}` : null);
  return (
    <div className="space-y-6">
      <PageHeader description="Workload by marketplace. Counts cover the whole team; the list shows the tasks you can open." />
      {!data ? <Skeleton className="h-32 rounded-2xl" /> : data.channels.length === 0 ? <Card><EmptyState icon="store" title="No channel activity yet" /></Card> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {data.channels.map((c) => (
            <button key={c.key} onClick={() => set({ channelId: c.key })} aria-pressed={sel?.key === c.key}
              className={cx("rounded-2xl border p-4 text-left transition", sel?.key === c.key ? "border-brand bg-brand-soft" : "border-slate-200/70 bg-white shadow-card hover:border-brand/30")}>
              <div className="flex items-center gap-2"><Icon name="store" size={18} className="text-slate-500" /><p className="truncate font-bold">{c.label}</p></div>
              <p className="mt-3 text-2xl font-extrabold tabular">{c.active}<span className="ml-1 text-sm font-semibold text-slate-500">active</span></p>
              <p className="text-xs text-slate-500"><span className={cx(c.overdue > 0 && "font-bold text-red-600")}>{c.overdue} overdue</span> · {c.dueSoon} due soon</p>
            </button>
          ))}
        </div>
      )}
      {sel && (
        <Card>
          <CardHeader title={sel.label} subtitle={data?.drilldown ? "All open tasks in this channel." : "Open tasks in this channel that you own or are involved in."} />
          {isLoading && !tasks ? <Skeleton className="m-5 h-24" /> : !tasks?.length ? <EmptyState icon="tasks" title="No tasks you can see here" /> : <TaskTable rows={tasks} />}
        </Card>
      )}
    </div>
  );
}
