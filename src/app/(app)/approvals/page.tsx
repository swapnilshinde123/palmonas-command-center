"use client";
import Link from "next/link";
import { useState } from "react";
import type { approvalsInbox } from "@/domain/governance";
import { api, refreshAll, useApi } from "@/components/client";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, fmtDate, fmtRelative, Skeleton, PageHeader } from "@/components/ui";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type Inbox = Awaited<ReturnType<typeof approvalsInbox>>;

export default function ApprovalsPage() {
  const { data, error, isLoading, mutate } = useApi<Inbox>("/approvals");
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const n = (id: string | null) => (id ? data?.names[id] ?? "—" : "—");
  const decide = (path: string, decision: "APPROVE" | "REJECT", what: string, intro?: string) => setSpec({
    title: `${decision === "APPROVE" ? "Approve" : "Reject"} ${what}`, submitLabel: decision === "APPROVE" ? "Approve" : "Reject", danger: decision === "REJECT", intro,
    fields: [{ name: "reason", label: decision === "APPROVE" ? "Note" : "Reason", type: "textarea", required: decision === "REJECT" }],
    run: async (v) => { const r = await api<{ warnings?: string[] }>(path, { body: { decision, reason: v.reason || null } }); await refreshAll(); toast.success(`${what[0].toUpperCase()}${what.slice(1)} ${decision === "APPROVE" ? "approved" : "rejected"}`, r?.warnings?.join(" ")); },
  });
  const empty = data && !data.transfers.length && !data.extensions.length && !data.waivers.length && !data.cancellations.length;
  const TaskLink = ({ t }: { t: { id: string; name: string; owner: { name: string } } }) => <><Link href={`/tasks/${encodeURIComponent(t.id)}`} className="font-bold hover:text-brand">{t.name}</Link><p className="text-xs text-slate-500">{t.id} · owner {t.owner.name}</p></>;

  return (
    <div className="space-y-6">
      <PageHeader description="Requests waiting for a decision. Extensions and waivers are separate decisions: approving one never approves the other." />
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      {isLoading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {empty && <Card><EmptyState icon="checkCircle" title="Nothing waiting" body="Requests you can decide, or that you raised, show up here." /></Card>}
      {data && data.transfers.length > 0 && (
        <Card>
          <CardHeader title="Transfers" subtitle="Ownership changes only when the new owner accepts." />
          <ul className="divide-y divide-slate-100">{data.transfers.map((t) => (
            <li key={t.id} className="flex flex-col gap-3 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div><TaskLink t={t.task} /><p className="mt-1">{n(t.fromUserId)} → <b>{n(t.toUserId)}</b> · {t.reason} {t.wasOverdueAtRequest && <Badge tone="amber">Overdue at request</Badge>}</p></div>
              <div className="flex flex-none gap-2">
                {t.canWithdraw && <Button size="sm" variant="ghost" onClick={async () => { await api(`/transfers/${t.id}/withdraw`, { body: {} }); await refreshAll(); toast.success("Transfer withdrawn"); }}>Withdraw</Button>}
                {t.canDecide && <><Button size="sm" onClick={() => decide(`/transfers/${t.id}/decision`, "REJECT", "transfer")}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide(`/transfers/${t.id}/decision`, "APPROVE", "transfer")}>Accept</Button></>}
              </div>
            </li>))}
          </ul>
        </Card>
      )}
      {data && data.extensions.length > 0 && (
        <Card>
          <CardHeader title="Extension requests" subtitle="Approving moves the deadline and counts toward KPI discipline unless a waiver is approved separately." />
          <ul className="divide-y divide-slate-100">{data.extensions.map((e) => (
            <li key={e.id} className="flex flex-col gap-3 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <TaskLink t={e.task} />
                <p className="mt-1"><b className="tabular">{fmtDate(e.previousDeadline)} → {fmtDate(e.requestedDeadline)}</b> (+{e.diffDays}d) {e.afterCompletion && <Badge tone="violet">After completion</Badge>} {e.waivers.some((w) => w.status === "PENDING") && <Badge tone="blue">Waiver also requested</Badge>}</p>
                <p className="text-slate-600">{e.reason}</p>
                <p className="text-xs text-slate-500">by {n(e.requestedById)} {fmtRelative(e.requestedAt)} · KPI impact if approved: {e.penaltyPreview} discipline pts unless waived</p>
              </div>
              {e.canDecide ? <div className="flex flex-none gap-2"><Button size="sm" onClick={() => decide(`/extensions/${e.id}/decision`, "REJECT", "extension")}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide(`/extensions/${e.id}/decision`, "APPROVE", "extension", "The deadline moves to the requested date. Any waiver is decided separately.")}>Approve</Button></div> : <Badge tone="amber">Awaiting decision</Badge>}
            </li>))}
          </ul>
        </Card>
      )}
      {data && data.waivers.length > 0 && (
        <Card>
          <CardHeader title="Waiver requests" subtitle="A waiver only changes how a penalty counts. It never moves a deadline or decides an extension." />
          <ul className="divide-y divide-slate-100">{data.waivers.map((w) => (
            <li key={w.id} className="flex flex-col gap-3 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <TaskLink t={w.task} />
                <p className="mt-1">{w.extension ? <>For extension to <b>{fmtDate(w.extension.requestedDeadline)}</b> <Badge>{w.extension.status.toLowerCase()}</Badge></> : <Badge>Not linked to an extension</Badge>}</p>
                <p className="text-slate-600">{w.reason}</p><p className="text-xs text-slate-500">by {n(w.requestedById)} {fmtRelative(w.requestedAt)}</p>
              </div>
              {w.canDecide ? <div className="flex flex-none gap-2"><Button size="sm" onClick={() => decide(`/waivers/${w.id}/decision`, "REJECT", "waiver")}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide(`/waivers/${w.id}/decision`, "APPROVE", "waiver", "This decision doesn't change the extension.")}>Approve</Button></div> : <Badge tone="amber">Awaiting decision</Badge>}
            </li>))}
          </ul>
        </Card>
      )}
      {data && data.cancellations.length > 0 && (
        <Card>
          <CardHeader title="Drop / removal requests" subtitle="Members can't drop or bin tasks themselves." />
          <ul className="divide-y divide-slate-100">{data.cancellations.map((c) => (
            <li key={c.id} className="flex flex-col gap-3 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div><TaskLink t={c.task} /><p className="mt-1"><Badge tone={c.kind === "DELETE" ? "red" : "amber"}>{c.kind === "DELETE" ? "Move to Bin" : "Drop"}</Badge> {c.reason}</p><p className="text-xs text-slate-500">by {n(c.requestedById)} {fmtRelative(c.requestedAt)}</p></div>
              {c.canDecide ? <div className="flex flex-none gap-2"><Button size="sm" onClick={() => decide(`/cancellations/${c.id}/decision`, "REJECT", "request")}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide(`/cancellations/${c.id}/decision`, "APPROVE", "request")}>Approve</Button></div> : <Badge tone="amber">Awaiting decision</Badge>}
            </li>))}
          </ul>
        </Card>
      )}
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}
