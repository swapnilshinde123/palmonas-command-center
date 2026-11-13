"use client";
import { Suspense, useState } from "react";
import type { scorecard } from "@/domain/scorecard";
import { api, refreshAll, useApi } from "@/components/client";
import { useUrlState } from "@/components/useUrlState";
import { useWorkspace } from "@/components/workspace";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader, Skeleton } from "@/components/ui";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type SC = Awaited<ReturnType<typeof scorecard>>;
const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

export default function KpiPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Kpi /></Suspense>;
}

function Kpi() {
  const [f, set] = useUrlState(["month"] as const);
  const month = f.month || thisMonth();
  const { data, error, isLoading, mutate } = useApi<SC>(`/scorecard?month=${month}`);
  const { ws } = useWorkspace();
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const adjust = () => setSpec({
    title: "Score adjustment", submitLabel: "Record adjustment", description: data?.closed ? "This month is closed: the adjustment is shown as a correction next to the frozen score." : undefined,
    fields: [{ name: "userId", label: "Team member", type: "select", required: true, options: (ws?.users ?? []).map((u) => ({ value: u.id, label: u.name })) }, { name: "points", label: "Points (+/−)", required: true, placeholder: "e.g. 2 or -1.5" }, { name: "reason", label: "Reason", type: "textarea", required: true }],
    run: async (v) => { await api("/scorecard/adjust", { body: { userId: v.userId, month, points: Number(v.points), reason: v.reason } }); await refreshAll(); toast.success("Adjustment recorded"); },
  });
  const close = () => setSpec({ title: `Close ${month}?`, submitLabel: "Close period", danger: true, intro: "Scores for this month are frozen. Later changes, such as an extension approved after completion, appear as separate corrections.", fields: [], run: async () => { await api("/scorecard/close", { body: { month } }); await refreshAll(); toast.success("Period closed"); } });
  return (
    <div className="space-y-6">
      <PageHeader description="The KPI tracker. It reads approved extensions and waivers; it never changes task deadlines or history." actions={<div className="flex gap-2"><Input type="month" aria-label="Month" value={month} onChange={(e) => set({ month: e.target.value || null })} className="w-44" />{data?.canOverride && <Button icon="edit" onClick={adjust}>Adjust</Button>}{data?.canClose && !data.closed && month < thisMonth() && <Button variant="dark" icon="lock" onClick={close}>Close month</Button>}</div>} />
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      {data && (
        <Alert tone="info">Scoring policy v{data.policyVersion}: on time +{data.policy.delivery.onTimePoints}, late +{data.policy.delivery.latePoints}; dependencies I +{data.policy.dependencies.I} / WB +{data.policy.dependencies.WB} / E +{data.policy.dependencies.E} (cap {data.policy.dependencies.monthlyCap}); discipline starts at {data.policy.discipline.base}, −{data.policy.discipline.penaltyPerUnwaivedExtension} per unwaived extension. Weights are awaiting sign-off (DEC-021/026).</Alert>
      )}
      <Card>
        <CardHeader title={`Scoreboard · ${month}`} subtitle={data?.closed ? `Closed ${new Date(data.closedAt!).toLocaleDateString("en-GB")}` : "Live for the current, open month"} action={data?.closed ? <Badge tone="slate" icon="lock">Frozen</Badge> : <Badge tone="green">Open</Badge>} />
        {isLoading && !data ? <Skeleton className="m-5 h-40" /> : !data?.rows.length ? <EmptyState icon="gauge" title="No scores for this month" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-y border-slate-100 bg-slate-50/60 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-5 py-3">Member</th><th className="px-3 py-3 text-right">On time</th><th className="px-3 py-3 text-right">Late</th><th className="px-3 py-3 text-right">Delivery</th><th className="px-3 py-3 text-right">Deps</th><th className="px-3 py-3 text-right">Ext. (waived)</th><th className="px-3 py-3 text-right">Discipline</th><th className="px-3 py-3 text-right">Adj.</th><th className="px-5 py-3 text-right">Total</th>
              </tr></thead>
              <tbody>{data.rows.map((r, i) => (
                <tr key={r.userId} className="border-b border-slate-100 last:border-0">
                  <th scope="row" className="px-5 py-3 text-left font-semibold"><span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600 tabular">{i + 1}</span>{r.name}</th>
                  <td className="px-3 py-3 text-right tabular">{r.completedOnTime}</td><td className="px-3 py-3 text-right tabular">{r.completedLate}</td><td className="px-3 py-3 text-right tabular">{r.deliveryPts}</td>
                  <td className="px-3 py-3 text-right tabular">{r.dependencyPts}</td><td className="px-3 py-3 text-right tabular">{r.extensionsApproved} ({r.extensionsWaived})</td><td className="px-3 py-3 text-right tabular">{r.disciplinePts}</td>
                  <td className="px-3 py-3 text-right tabular">{r.adjustments}{r.postCloseAdjustment ? <span className="block text-xs text-violet-700">+{r.postCloseAdjustment} correction</span> : null}</td>
                  <td className="px-5 py-3 text-right text-base font-extrabold tabular">{r.total}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data && data.adjustments.length > 0 && (
        <Card><CardHeader title="Adjustments" /><ul className="divide-y divide-slate-100 text-sm">{data.adjustments.map((a) => <li key={a.id} className="flex justify-between px-5 py-3"><span>{ws?.users.find((u) => u.id === a.userId)?.name ?? a.userId}: {a.reason}</span><Badge tone={a.kind === "CORRECTION" ? "violet" : "blue"}>{a.points > 0 ? "+" : ""}{a.points} {a.kind.toLowerCase()}</Badge></li>)}</ul></Card>
      )}
    </div>
  );
}
