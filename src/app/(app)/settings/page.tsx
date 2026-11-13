"use client";
import { useState } from "react";
import type { adminOverview, notificationQueue } from "@/domain/admin";
import { api, refreshAll, useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { POC_LABEL, type PocType } from "@/components/workspace";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, fmtDate, fmtRelative, Input, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type Overview = Awaited<ReturnType<typeof adminOverview>>;
type Queue = Awaited<ReturnType<typeof notificationQueue>>;
type Poc = { id: string; name: string; type: PocType; organisation: string; contact: string };

export default function SettingsPage() {
  const { can } = useMe();
  const allowed = can("settings.manage");
  const { data, error, mutate } = useApi<Overview>(allowed ? "/admin" : null);
  const { data: queue } = useApi<Queue>(allowed ? "/admin/notifications" : null);
  const { data: pocs } = useApi<Poc[]>(allowed ? "/pocs" : null);
  const [tab, setTab] = useState("workflow");
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  if (!allowed) return <Card><EmptyState icon="lock" title="Settings are for admins" /></Card>;
  if (error) return <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>;
  if (!data) return <Skeleton className="h-96 rounded-2xl" />;
  const cfg = data.config;
  const save = async (key: string, value: Record<string, unknown>, ok = "Saved") => {
    try { await api("/admin/config", { body: { key, value } }); await refreshAll(); toast.success(ok); } catch (e) { toast.error("Couldn't save", (e as Error).message); }
  };

  const emailOn = cfg.notifications.emailDelivery === "ON";
  const toggleEmail = () => setSpec({
    title: emailOn ? "Turn email delivery off?" : "Turn email delivery on?", submitLabel: emailOn ? "Turn off" : "Turn on", danger: !emailOn,
    intro: emailOn ? "In-app notifications continue. Emails raised while delivery is off are recorded as skipped and never sent later."
      : <div className="space-y-2"><p>Emails start going out for new events only. Nothing that happened while delivery was off is sent, so there&apos;s no backlog flood.</p>{data.mailMode === "log" && <Alert tone="warning">SMTP isn&apos;t configured, so emails will only be logged in the outbox. Set SMTP_HOST and related variables to deliver them.</Alert>}</div>,
    fields: emailOn ? [] : [{ name: "ok", label: "The event list and recipients in docs/NOTIFICATIONS.md have been approved.", type: "checkbox", required: true }],
    run: async () => save("notifications", { emailDelivery: emailOn ? "OFF" : "ON" }, emailOn ? "Email delivery off" : "Email delivery on"),
  });
  const list = (kind: "channel" | "workstream", row?: { id: string; name: string; active: boolean }) => setSpec({
    title: row ? `Edit ${kind}` : `Add ${kind}`, submitLabel: "Save",
    fields: [{ name: "name", label: "Name", required: true }, ...(row ? [{ name: "active", label: "Active", type: "checkbox" as const, hint: "Inactive values stay on old tasks but can't be picked for new ones." }] : [])],
    initial: row ? { name: row.name, active: row.active } : {},
    run: async (v) => { await api(`/admin/lists/${kind}`, { body: { id: row?.id, name: v.name, ...(row ? { active: v.active === true } : {}) } }); await refreshAll(); toast.success("Saved"); },
  });
  const poc = (row?: Poc) => setSpec({
    title: row ? "Edit saved POC" : "Add saved POC", submitLabel: "Save",
    fields: [
      { name: "name", label: "Name", required: true }, { name: "type", label: "POC Type", type: "radio", required: true, options: (["I", "WB", "E"] as PocType[]).map((t) => ({ value: t, label: POC_LABEL[t] })) },
      { name: "organisation", label: "Organisation" }, { name: "contact", label: "Contact details" },
      ...(row ? [{ name: "active", label: "Active", type: "checkbox" as const, hint: "Deactivated POCs stay on past tasks but can't be picked." }] : []),
    ],
    initial: row ? { ...row, active: true } : {},
    run: async (v) => { await api(row ? `/pocs/${row.id}` : "/pocs", { method: row ? "PATCH" : "POST", body: { name: v.name, type: v.type, organisation: v.organisation || "", contact: v.contact || "", ...(row ? { active: v.active === true } : {}) } }); await refreshAll(); toast.success("Saved"); },
  });
  const holiday = () => setSpec({ title: "Add holiday", submitLabel: "Add", fields: [{ name: "date", label: "Date", type: "date", required: true }, { name: "name", label: "Name", required: true }], run: async (v) => { await api("/admin/holidays", { body: v }); await refreshAll(); toast.success("Holiday added"); } });

  return (
    <div className="space-y-6">
      <PageHeader description="Workflow thresholds, notifications and the lists people pick from." />
      <Segmented label="Settings section" value={tab} onChange={setTab} options={[{ value: "workflow", label: "Workflow" }, { value: "notifications", label: "Notifications" }, { value: "lists", label: "Lists" }, { value: "pocs", label: "Saved POCs" }, { value: "system", label: "System" }]} />

      {tab === "workflow" && (
        <Card>
          <CardHeader title="Due Soon & Follow-up Soon windows" subtitle="How far ahead the Due Soon page and counters look. Proposed defaults; confirm before go-live." />
          <DueForm initial={cfg.dueSoon} onSave={(v) => save("dueSoon", v)} />
        </Card>
      )}

      {tab === "notifications" && (
        <>
          <Card>
            <CardHeader title="Email delivery" subtitle="In-app (bell) notifications are always on." action={<Badge tone={emailOn ? "green" : "amber"}>{emailOn ? "On" : "Off"}</Badge>} />
            <div className="space-y-3 px-5 pb-5 text-sm text-slate-600">
              <p>{emailOn ? "Critical events (assignment, owner change, priority, deadline, escalation, extension and waiver decisions) are emailed." : "Off until the event list, recipients and sample emails are approved. Events are logged as skipped, so turning email on later never sends a backlog."}</p>
              <p>Transport: <b>{data.mailMode === "smtp" ? "SMTP configured" : "Not configured (emails are logged only)"}</b></p>
              <Button variant={emailOn ? "secondary" : "primary"} onClick={toggleEmail}>{emailOn ? "Turn off" : "Turn on email delivery"}</Button>
            </div>
          </Card>
          <Card>
            <CardHeader title="Daily focus digest" subtitle={`Personal 09:00 IST summary of each person's own work. Needs email delivery on.`} action={<Badge tone={cfg.notifications.digestsEnabled ? "green" : "slate"}>{cfg.notifications.digestsEnabled ? "On" : "Off"}</Badge>} />
            <div className="px-5 pb-5"><Button onClick={() => save("notifications", { digestsEnabled: !cfg.notifications.digestsEnabled })}>{cfg.notifications.digestsEnabled ? "Turn off" : "Turn on"}</Button></div>
          </Card>
          <Card>
            <CardHeader title="Email queue" subtitle="Each event is sent once. Failures retry with backoff, then land here as dead." />
            {!queue ? <Skeleton className="m-5 h-24" /> : (
              <div className="px-5 pb-5">
                <div className="mb-4 flex flex-wrap gap-2">{Object.entries(queue.counts).map(([k, v]) => <Badge key={k} tone={k === "DEAD" || k === "FAILED" ? "red" : k === "SENT" ? "green" : "slate"}>{k.toLowerCase()}: {v}</Badge>)}</div>
                {queue.rows.filter((r) => r.status === "DEAD" || r.status === "FAILED").length > 0 ? (
                  <>
                    <ul className="mb-3 divide-y divide-slate-100 rounded-xl border border-slate-100 text-sm">{queue.rows.filter((r) => r.status === "DEAD" || r.status === "FAILED").slice(0, 20).map((r) => <li key={r.id} className="px-3 py-2"><b>{r.subject}</b><p className="text-xs text-red-700">{r.errorCategory}: {r.error}</p><p className="text-xs text-slate-500">{r.attempts} attempts · {fmtRelative(r.lastAttemptAt)}</p></li>)}</ul>
                    <Button icon="refresh" onClick={async () => { await api("/admin/notifications", { body: { ids: queue.rows.filter((r) => r.status === "DEAD" || r.status === "FAILED").map((r) => r.id) } }); await refreshAll(); toast.success("Requeued"); }}>Retry failed</Button>
                  </>
                ) : <p className="text-sm text-slate-500">No failed emails.</p>}
              </div>
            )}
          </Card>
        </>
      )}

      {tab === "lists" && (
        <div className="grid gap-6 lg:grid-cols-2">
          {(["channel", "workstream"] as const).map((kind) => (
            <Card key={kind}>
              <CardHeader title={kind === "channel" ? "Channels" : "Workstreams"} action={<Button size="sm" icon="plus" onClick={() => list(kind)}>Add</Button>} />
              <ul className="divide-y divide-slate-100 text-sm">{(kind === "channel" ? data.channels : data.workstreams).map((c) => <li key={c.id} className="flex items-center justify-between px-5 py-2.5"><span className={c.active ? "" : "text-slate-400 line-through"}>{c.name}</span><Button size="sm" variant="ghost" onClick={() => list(kind, c)}>Edit</Button></li>)}</ul>
            </Card>
          ))}
          <Card>
            <CardHeader title="Holidays" subtitle="Used for working-day recurrence." action={<Button size="sm" icon="plus" onClick={holiday}>Add</Button>} />
            {data.holidays.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">None yet.</p> : <ul className="divide-y divide-slate-100 text-sm">{data.holidays.map((h) => <li key={h.date} className="flex items-center justify-between px-5 py-2.5"><span>{fmtDate(h.date)} · {h.name}</span><Button size="sm" variant="ghost" onClick={async () => { await api("/admin/holidays", { body: { date: h.date, remove: true } }); await refreshAll(); }}>Remove</Button></li>)}</ul>}
          </Card>
        </div>
      )}

      {tab === "pocs" && (
        <Card>
          <CardHeader title="Saved POCs" subtitle="Everyone can pick these. New ones usually come from custom POCs that L1 approves on the Pending From page." action={<Button size="sm" icon="plus" onClick={() => poc()}>Add POC</Button>} />
          {!pocs ? <Skeleton className="m-5 h-24" /> : pocs.length === 0 ? <EmptyState icon="users" title="No saved POCs" /> : (
            <ul className="divide-y divide-slate-100 text-sm">{pocs.map((p) => <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-2.5"><span className="min-w-0"><b>{p.name}</b> <Badge>{POC_LABEL[p.type]}</Badge><span className="block truncate text-xs text-slate-500">{[p.organisation, p.contact].filter(Boolean).join(" · ")}</span></span><Button size="sm" variant="ghost" onClick={() => poc(p)}>Edit</Button></li>)}</ul>
          )}
        </Card>
      )}

      {tab === "system" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Background jobs" subtitle="Recurring task creation and email sending run inside the app every minute." />
            {data.heartbeats.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">No runs recorded yet. Jobs start about a minute after the server boots.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">{data.heartbeats.map((h) => { const d = h.detail as { ok?: boolean; error?: string } | null; return <li key={h.name} className="flex items-center justify-between px-5 py-2.5"><span>{h.name.replace("job:", "")}</span><span className="flex items-center gap-2 text-xs text-slate-500">{fmtRelative(h.lastRunAt)}<Badge tone={d?.ok ? "green" : "red"}>{d?.ok ? "ok" : "failed"}</Badge></span></li>; })}</ul>
            )}
          </Card>
          <IntegrityCard />
        </div>
      )}
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}

function DueForm({ initial, onSave }: { initial: { deadlineDays: number; followupDays: number }; onSave: (v: { deadlineDays: number; followupDays: number }) => void }) {
  const [v, setV] = useState({ deadlineDays: String(initial.deadlineDays), followupDays: String(initial.followupDays) });
  const bad = (s: string) => !/^\d{1,2}$/.test(s) || Number(s) > 30;
  return (
    <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end">
      <label className="text-sm font-semibold text-slate-700">Deadline within (days)<Input className="mt-1.5 w-32" inputMode="numeric" value={v.deadlineDays} invalid={bad(v.deadlineDays)} onChange={(e) => setV({ ...v, deadlineDays: e.target.value })} /></label>
      <label className="text-sm font-semibold text-slate-700">Follow-up within (days)<Input className="mt-1.5 w-32" inputMode="numeric" value={v.followupDays} invalid={bad(v.followupDays)} onChange={(e) => setV({ ...v, followupDays: e.target.value })} /></label>
      <Button variant="primary" disabled={bad(v.deadlineDays) || bad(v.followupDays)} onClick={() => onSave({ deadlineDays: Number(v.deadlineDays), followupDays: Number(v.followupDays) })}>Save windows</Button>
    </div>
  );
}

function IntegrityCard() {
  const [run, setRun] = useState(false);
  const { data, isLoading } = useApi<Record<string, unknown>>(run ? "/admin/integrity" : null);
  return (
    <Card>
      <CardHeader title="Data integrity check" subtitle="Recounts KPIs and checks IDs, counters and escalation flags." action={<Button size="sm" onClick={() => setRun(true)} busy={isLoading}>Run check</Button>} />
      {data && <pre className="mx-5 mb-5 max-h-80 overflow-auto rounded-xl bg-slate-50 p-3 text-xs">{JSON.stringify(data, null, 2)}</pre>}
    </Card>
  );
}
