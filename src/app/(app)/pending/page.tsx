"use client";
import { Suspense, useState } from "react";
import { api, refreshAll, useApi } from "@/components/client";
import { useUrlState } from "@/components/useUrlState";
import { useWorkspace, POC_LABEL, type PocType, type Task } from "@/components/workspace";
import { Alert, Badge, Button, Card, CardHeader, cx, EmptyState, fmtRelative, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { TaskTable } from "@/components/tasks/TaskTable";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type View = { view: string; counts: Partial<Record<PocType, number>>; rows: (Task & { followupDue: boolean })[] };
type Promo = { id: string; name: string; type: PocType; typeLabel: string; organisation: string; contact: string; requestedBy: string; requestedAt: string; duplicates: { id: string; name: string; type: PocType }[]; canDecide: boolean };

export default function PendingPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Pending /></Suspense>;
}

function Pending() {
  const { ws } = useWorkspace();
  const [f, set] = useUrlState(["type", "view", "tab"] as const);
  const showQueue = !!ws && (ws.escalationLevel === "L1" || ws.privileged);
  const tab = f.tab === "registry" && showQueue ? "registry" : "tasks";
  const qs = new URLSearchParams(Object.entries({ type: f.type, view: f.view }).filter(([, v]) => v) as [string, string][]).toString();
  const { data, error, isLoading, mutate } = useApi<View>(tab === "tasks" ? `/pending?${qs}` : null);
  const { data: promos } = useApi<Promo[]>(showQueue ? "/pocs/promotions" : null);
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const total = Object.values(data?.counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);

  const approve = (p: Promo) => setSpec({
    title: `Add “${p.name}” to saved POCs`, submitLabel: "Approve", description: `${p.typeLabel} · requested by ${p.requestedBy}`,
    intro: p.duplicates.length ? <Alert tone="warning">Similar saved POCs: {p.duplicates.map((d) => `${d.name} (${POC_LABEL[d.type]})`).join(", ")}</Alert> : <p>No similar names found in the saved list.</p>,
    fields: [
      { name: "name", label: "Canonical name", required: true, hint: "Tidy the name if needed. This is how everyone will see it." },
      { name: "verifiedNotDuplicate", label: "I have verified that this is not a duplicate entry.", type: "checkbox", required: true },
    ],
    initial: { name: p.name },
    run: async (v) => { await api(`/pocs/${p.id}/decision`, { body: { decision: "APPROVE", name: v.name, verifiedNotDuplicate: v.verifiedNotDuplicate === true } }); await refreshAll(); toast.success("POC saved", `${v.name} is now in the shared list.`); },
  });
  const reject = (p: Promo) => setSpec({
    title: `Keep “${p.name}” task-only?`, submitLabel: "Decline", danger: true, fields: [{ name: "reason", label: "Reason", type: "textarea", required: true, placeholder: "e.g. Same as Amazon Seller Support" }],
    run: async (v) => { await api(`/pocs/${p.id}/decision`, { body: { decision: "REJECT", reason: v.reason } }); await refreshAll(); toast.success("Declined"); },
  });

  return (
    <div className="space-y-6">
      <PageHeader description="What we're waiting for, and from whom. This is a dependency map, not an escalation queue." />
      {showQueue && <Segmented label="Section" value={tab} onChange={(v) => set({ tab: v === "tasks" ? null : v })} options={[{ value: "tasks", label: "Pending tasks" }, { value: "registry", label: "POC approvals", count: promos?.length }]} />}
      {tab === "tasks" ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([["", "All", total], ["I", "Internal", data?.counts.I ?? 0], ["WB", "Within Brand", data?.counts.WB ?? 0], ["E", "External", data?.counts.E ?? 0]] as const).map(([k, l, c]) => (
              <button key={k} onClick={() => set({ type: k || null })} aria-pressed={(f.type || "") === k}
                className={cx("rounded-2xl border p-4 text-left transition", (f.type || "") === k ? "border-brand bg-brand-soft" : "border-slate-200/70 bg-white shadow-card hover:border-brand/30")}>
                <p className="text-2xl font-extrabold tabular">{c}</p><p className="text-sm font-semibold text-slate-600">{l}</p>
              </button>
            ))}
          </div>
          {ws?.privileged && <Segmented label="Whose" value={data?.view ?? "team"} onChange={(v) => set({ view: v })} options={[{ value: "mine", label: "Mine" }, { value: "team", label: "Whole team" }]} />}
          {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
          <Card>
            {isLoading && !data ? <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
              : !data?.rows.length ? <EmptyState icon="hourglass" title="Nobody to chase" body={f.type ? `No tasks waiting on ${POC_LABEL[f.type as PocType]} POCs.` : "No tasks are waiting on anyone."} />
              : <TaskTable rows={data.rows} extraLabel="Waiting on" extra={(t) => (
                  <div><p className="text-xs font-bold uppercase tracking-wide text-slate-400">{t.pocTypeLabel}</p><p className="font-semibold">{t.pendingFrom}</p>
                    <p className="text-xs text-slate-500">since {t.pendingSince ? fmtRelative(t.pendingSince) : "—"}{t.followupDue && <span className="ml-1 font-semibold text-violet-700">· follow-up due</span>}</p></div>
                )} />}
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader title="Custom POCs waiting for L1" subtitle="Approving adds the POC to the saved list for everyone. You must confirm it isn't a duplicate." />
          {!promos ? <Skeleton className="m-5 h-24" /> : promos.length === 0 ? <EmptyState icon="checkCircle" title="No POCs waiting" /> : (
            <ul className="divide-y divide-slate-100">
              {promos.map((p) => (
                <li key={p.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm"><p className="font-bold">{p.name} <Badge>{p.typeLabel}</Badge></p><p className="text-slate-500">{[p.organisation, p.contact].filter(Boolean).join(" · ") || "No contact details"} · requested by {p.requestedBy} {fmtRelative(p.requestedAt)}</p>{p.duplicates.length > 0 && <p className="mt-1 text-xs font-semibold text-amber-700">{p.duplicates.length} similar saved POC{p.duplicates.length > 1 ? "s" : ""}</p>}</div>
                  {p.canDecide ? <div className="flex gap-2"><Button size="sm" onClick={() => reject(p)}>Decline</Button><Button size="sm" variant="primary" onClick={() => approve(p)}>Review &amp; approve</Button></div> : <Badge tone="amber">Waiting for L1</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}
