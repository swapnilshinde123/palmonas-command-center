"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { api, refreshAll, useApi } from "@/components/client";
import { useUrlState } from "@/components/useUrlState";
import { Alert, Badge, Button, Card, cx, EmptyState, fmtRelative, Icon, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { LevelBadge, PriorityBadge, StatusBadge } from "@/components/tasks/bits";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type Row = {
  id: string; level: "L1" | "L2" | "L3"; active: boolean; reason: string; assigneeId: string | null; assignee: string; raisedBy: string; triggeredAt: string; resolvedAt: string | null;
  resolutionRemarks: string | null; resolvedBy: string | null; lastUpdateAt: string; hoursOpen: number; history: { from: string; to: string; at: string; by: string; cause: string }[];
  task: { id: string; name: string; priority: number; status: string; deadline: string | null; overdue: boolean; owner: { name: string }; channel: { name: string } };
};
type View = { canAct: boolean; owners: { level: string; name: string | null }[]; rows: Row[] };

export default function EscalationsPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Escalations /></Suspense>;
}

function Escalations() {
  const [f, set] = useUrlState(["level", "mine", "resolution"] as const);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const { data, error, isLoading, mutate } = useApi<View>(`/escalations?${qs}`);
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const resolved = f.resolution === "resolved";

  const reassign = (r: Row) => setSpec({
    title: "Reassign escalation", submitLabel: "Reassign", description: `${r.task.name} · currently ${r.level} (${r.assignee})`,
    fields: [
      { name: "level", label: "Move to", type: "radio", required: true, options: (data?.owners ?? []).filter((o) => o.level !== r.level).map((o) => ({ value: o.level, label: o.level, hint: o.name ?? "Not assigned" })) },
      { name: "reason", label: "Reason", type: "textarea", required: true },
    ],
    run: async (v) => { await api(`/escalations/${r.id}/reassign`, { body: v }); await refreshAll(); toast.success(`Moved to ${v.level}`); },
  });
  const resolve = (r: Row) => setSpec({
    title: "Resolve escalation", submitLabel: "Resolve", description: r.task.name, intro: "Closes the escalation. The task's own status doesn't change.",
    fields: [{ name: "remarks", label: "Resolution notes", type: "textarea", required: true }],
    run: async (v) => { await api(`/escalations/${r.id}/resolve`, { body: v }); await refreshAll(); toast.success("Escalation resolved"); },
  });

  return (
    <div className="space-y-6">
      <PageHeader description="Urgent work that needs L1, L2 or L3 to step in. Sorted by level, then priority, then deadline." />
      {data && (
        <div className="grid gap-3 sm:grid-cols-3">
          {data.owners.map((o) => {
            const n = data.rows.filter((r) => r.level === o.level).length;
            return (
              <button key={o.level} onClick={() => set({ level: f.level === o.level ? null : o.level })} aria-pressed={f.level === o.level}
                className={cx("flex items-center gap-4 rounded-2xl border p-4 text-left transition", f.level === o.level ? "border-brand bg-brand-soft" : "border-slate-200/70 bg-white shadow-card hover:border-brand/30")}>
                <LevelBadge level={o.level} />
                <span className="min-w-0 flex-1"><span className="block truncate font-bold">{o.name ?? "Not assigned"}</span><span className="text-xs text-slate-500">{o.level} escalation owner</span></span>
                <span className="text-2xl font-extrabold tabular">{resolved ? "" : n}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Segmented label="State" value={f.resolution || "active"} onChange={(v) => set({ resolution: v === "active" ? null : v })} options={[{ value: "active", label: "Active" }, { value: "resolved", label: "Resolved (90 days)" }]} />
        {data?.canAct && <Segmented label="Assignee" value={f.mine || "all"} onChange={(v) => set({ mine: v === "all" ? null : v })} options={[{ value: "all", label: "All I can see" }, { value: "true", label: "Assigned to me" }]} />}
      </div>
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      {isLoading && !data ? <Skeleton className="h-64 rounded-2xl" /> : !data?.rows.length ? (
        <Card><EmptyState icon="flame" title={resolved ? "No resolved escalations" : "No active escalations"} body={resolved ? undefined : "Escalate a task from its page when it needs urgent help."} /></Card>
      ) : (
        <div className="space-y-3">
          {data.rows.map((r) => (
            <Card key={r.id} as="article" className={cx("p-4 sm:p-5", r.active && r.level === "L3" && "border-red-200")}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><LevelBadge level={r.level} /><PriorityBadge p={r.task.priority} /><StatusBadge status={r.task.status} />{r.task.overdue && <Badge tone="red" icon="alert">Overdue</Badge>}</div>
                  <Link href={`/tasks/${encodeURIComponent(r.task.id)}`} className="mt-2 block text-base font-bold hover:text-brand">{r.task.name}</Link>
                  <p className="text-xs text-slate-500">{r.task.id} · {r.task.channel.name} · owner {r.task.owner.name} · due {r.task.deadline}</p>
                  <p className="mt-2 text-sm text-slate-700"><Icon name="alert" size={14} className="mr-1 inline text-slate-400" />{r.reason}</p>
                  <p className="mt-1 text-xs text-slate-500">Raised by {r.raisedBy} {fmtRelative(r.triggeredAt)} · assigned to <b>{r.assignee}</b> · {r.hoursOpen}h open · last update {fmtRelative(r.lastUpdateAt)}</p>
                  {r.history.length > 1 && <p className="mt-1 text-xs text-slate-500">Path: {r.history.map((h) => h.to).join(" → ")} (latest: {r.history[r.history.length - 1].cause})</p>}
                  {r.resolutionRemarks && <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">Resolved by {r.resolvedBy}: {r.resolutionRemarks}</p>}
                </div>
                {r.active && data.canAct && <div className="flex flex-none gap-2"><Button size="sm" icon="refresh" onClick={() => reassign(r)}>Reassign</Button><Button size="sm" variant="primary" icon="check" onClick={() => resolve(r)}>Resolve</Button></div>}
              </div>
            </Card>
          ))}
        </div>
      )}
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}
