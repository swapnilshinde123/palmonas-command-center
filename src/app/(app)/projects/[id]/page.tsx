"use client";
import Link from "next/link";
import { use, useState } from "react";
import type { projectDetail } from "@/domain/projects";
import { api, refreshAll, useApi } from "@/components/client";
import { Badge, Button, Card, CardHeader, EmptyState, fmtDate, Icon, Skeleton } from "@/components/ui";
import { TaskTable } from "@/components/tasks/TaskTable";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type D = Awaited<ReturnType<typeof projectDetail>>;
const TONE: Record<string, "green" | "amber" | "blue" | "slate"> = { ACTIVE: "blue", ON_HOLD: "amber", COMPLETED: "green", ARCHIVED: "slate" };
const NEXT: Record<string, string[]> = { ACTIVE: ["ON_HOLD", "COMPLETED"], ON_HOLD: ["ACTIVE", "COMPLETED"], COMPLETED: ["ACTIVE", "ARCHIVED"], ARCHIVED: ["ACTIVE"] };

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useApi<D>(`/projects/${id}`);
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  if (error) return <Card><EmptyState icon="folder" title="Project not found" body={error.message} action={<Link href="/projects"><Button>Back to projects</Button></Link>} /></Card>;
  if (!data) return <Skeleton className="h-96 rounded-2xl" />;
  const p = data.project, r = data.rollup;
  const move = (to: string) => setSpec({
    title: `Mark project ${to.replace("_", " ").toLowerCase()}`, submitLabel: "Update",
    intro: to === "COMPLETED" && r.active > 0 ? `${r.active} linked task(s) are still active. Completing needs an override and a reason; tasks aren't auto-completed.` : undefined,
    fields: [{ name: "reason", label: "Note", type: "textarea", required: to === "COMPLETED" && r.active > 0 }, ...(to === "COMPLETED" && r.active > 0 ? [{ name: "overrideOpenTasks", label: "Complete with active tasks", type: "checkbox" as const, required: true }] : [])],
    run: async (v) => { await api(`/projects/${id}/status`, { body: { to, expectedVersion: p.version, reason: v.reason || null, overrideOpenTasks: v.overrideOpenTasks === true } }); await refreshAll(); toast.success("Project updated"); },
  });
  return (
    <div className="space-y-6">
      <Link href="/projects" className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-brand"><Icon name="chevronLeft" size={16} />Projects</Link>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="text-xs text-slate-500">{p.id}</p><h2 className="text-2xl font-extrabold">{p.name}</h2><p className="mt-1 max-w-2xl text-sm text-slate-600">{p.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm"><Badge tone={TONE[p.status]}>{p.status.replace("_", " ").toLowerCase()}</Badge><span className="text-slate-500">Owner {p.owner.name}{p.targetDate && ` · target ${fmtDate(p.targetDate)}`}</span></div></div>
          {r.canManage && <div className="flex flex-wrap gap-2">{NEXT[p.status].map((s) => <Button key={s} size="sm" onClick={() => move(s)}>{s === "ACTIVE" ? "Reopen" : s === "ON_HOLD" ? "Put on hold" : s.charAt(0) + s.slice(1).toLowerCase()}</Button>)}</div>}
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-100 pt-5 sm:grid-cols-5">
          {[["Tasks", r.total], ["Done", `${r.completed} (${r.taskCompletionPct ?? 0}%)`], ["Active", r.active], ["Overdue", r.overdue], ["Escalated", r.escalated]].map(([k, v]) => <div key={k as string}><dt className="text-xs font-bold uppercase tracking-wide text-slate-400">{k}</dt><dd className="text-xl font-extrabold tabular">{v}</dd></div>)}
        </dl>
      </Card>
      {p.milestones.length > 0 && (
        <Card><CardHeader title="Milestones" subtitle={r.milestoneProgressPct != null ? `${r.milestoneProgressPct}% by weight` : undefined} />
          <ul className="divide-y divide-slate-100 text-sm">{p.milestones.map((m) => <li key={m.id} className="flex items-center justify-between px-5 py-3"><span className="font-semibold">{m.name}</span><span className="flex items-center gap-2 text-slate-500">{fmtDate(m.targetDate)} <Badge tone={m.status === "DONE" ? "green" : m.status === "MISSED" ? "red" : "slate"}>{m.status.toLowerCase().replace("_", " ")}</Badge></span></li>)}</ul>
        </Card>
      )}
      <Card>
        <CardHeader title="Tasks" subtitle="Only tasks you can open are listed." />
        {data.tasks.length === 0 ? <EmptyState icon="tasks" title="No tasks you can see in this project" /> : <TaskTable rows={data.tasks} />}
      </Card>
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}
