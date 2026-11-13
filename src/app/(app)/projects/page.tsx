"use client";
import Link from "next/link";
import { useState } from "react";
import type { projectRollups } from "@/domain/projects";
import { api, refreshAll, useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, cx, EmptyState, fmtDate, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type P = Awaited<ReturnType<typeof projectRollups>>[number];
const PROJECT_TONE: Record<string, "green" | "amber" | "blue" | "slate"> = { ACTIVE: "blue", ON_HOLD: "amber", COMPLETED: "green", ARCHIVED: "slate" };

export default function ProjectsPage() {
  const { data, error, isLoading, mutate } = useApi<P[]>("/projects");
  const { data: me } = useMe();
  const { ws } = useWorkspace();
  const [status, setStatus] = useState("ACTIVE");
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const rows = (data ?? []).filter((p) => status === "ALL" || p.status === status);
  const create = () => setSpec({
    title: "New project", submitLabel: "Create project",
    fields: [
      { name: "name", label: "Project name", required: true }, { name: "description", label: "Description", type: "textarea" },
      { name: "ownerId", label: "Owner", type: "select", required: true, options: (ws?.users ?? []).map((u) => ({ value: u.id, label: u.name })), hint: ws?.privileged ? undefined : "You can create projects you own." },
      { name: "startDate", label: "Start date", type: "date" }, { name: "targetDate", label: "Target date", type: "date" },
    ],
    initial: { ownerId: me?.me.id ?? "" },
    run: async (v) => { await api("/projects", { body: v }); await refreshAll(); toast.success("Project created"); },
  });
  return (
    <div className="space-y-6">
      <PageHeader description="Group related tasks across owners and channels. Progress counts cover the whole project; task lists show only what you can open." actions={<Button variant="primary" icon="plus" onClick={create}>New project</Button>} />
      <Segmented label="Project status" value={status} onChange={setStatus} options={["ACTIVE", "ON_HOLD", "COMPLETED", "ARCHIVED", "ALL"].map((s) => ({ value: s, label: s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase().replace("_", " "), count: s === "ALL" ? data?.length : data?.filter((p) => p.status === s).length }))} />
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      {isLoading && !data ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-52 rounded-2xl" />)}</div>
        : rows.length === 0 ? <Card><EmptyState icon="folder" title="No projects here" action={<Button icon="plus" onClick={create}>New project</Button>} /></Card> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="block">
                <Card as="article" className="flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-brand/30">
                  <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs text-slate-500">{p.id}</p><h2 className="truncate text-lg font-bold">{p.name}</h2></div><Badge tone={PROJECT_TONE[p.status]}>{p.status.replace("_", " ").toLowerCase()}</Badge></div>
                  <p className="mt-1 line-clamp-2 flex-1 text-sm text-slate-600">{p.description || "No description."}</p>
                  <div className="mt-4">
                    <div className="flex justify-between text-xs font-semibold text-slate-500"><span>{p.completed}/{p.total} tasks done</span><span>{p.taskCompletionPct ?? 0}%</span></div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${p.taskCompletionPct ?? 0}%` }} /></div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
                    <span>{p.owner.name}</span><span>{p.active} active</span><span className={cx(p.overdue > 0 && "font-bold text-red-600")}>{p.overdue} overdue</span>{p.targetDate && <span>Target {fmtDate(p.targetDate, { day: "numeric", month: "short" })}</span>}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}
