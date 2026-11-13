"use client";
import Link from "next/link";
import { use, useState } from "react";
import type { getTaskDetail } from "@/domain/tasks";
import { api, ApiError, refreshAll, useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { useWorkspace, POC_LABEL, type PocType } from "@/components/workspace";
import { Alert, Badge, Button, Card, CardHeader, cx, EmptyState, fmtDate, fmtRelative, Icon, Menu, Skeleton } from "@/components/ui";
import { DeadlineText, EVENT_LABEL, LevelBadge, PocBadge, PriorityBadge, StatusBadge } from "@/components/tasks/bits";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { BinModal } from "@/components/tasks/BinModal";
import { EditTaskModal } from "@/components/tasks/EditTaskModal";
import { toast } from "@/components/toast";

type Detail = Awaited<ReturnType<typeof getTaskDetail>>;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

const NEXT: Record<string, { to: string; label: string; reason?: boolean; icon: "play" | "pause" | "checkCircle" | "refresh" | "ban" }[]> = {
  NOT_STARTED: [{ to: "IN_PROGRESS", label: "Start", icon: "play" }, { to: "COMPLETED", label: "Mark complete", icon: "checkCircle" }, { to: "ON_HOLD", label: "Put on hold", icon: "pause" }],
  IN_PROGRESS: [{ to: "COMPLETED", label: "Mark complete", icon: "checkCircle" }, { to: "ON_HOLD", label: "Put on hold", icon: "pause" }],
  ON_HOLD: [{ to: "IN_PROGRESS", label: "Resume", icon: "play" }, { to: "COMPLETED", label: "Mark complete", icon: "checkCircle" }],
  COMPLETED: [{ to: "IN_PROGRESS", label: "Reopen", reason: true, icon: "refresh" }],
  DROPPED: [{ to: "NOT_STARTED", label: "Reopen", reason: true, icon: "refresh" }],
};

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, isLoading, mutate } = useApi<Detail>(`/tasks/${encodeURIComponent(id)}`);
  const { data: me } = useMe();
  const { ws } = useWorkspace();
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const [edit, setEdit] = useState(false);
  const [bin, setBin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (isLoading && !data) return <div className="space-y-4"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-72 rounded-2xl" /></div>;
  if (error || !data) {
    const nf = (error as ApiError | undefined)?.status === 404;
    return <Card><EmptyState icon={nf ? "lock" : "alert"} title={nf ? "Task not found" : "Couldn't load this task"} body={nf ? "It doesn't exist, was purged, or you don't have access to it." : error?.message} action={<Link href="/tasks"><Button>Back to tasks</Button></Link>} /></Card>;
  }

  const { task: t, permissions: can } = data;
  const n = (uid: string | null | undefined) => (uid ? data.names[uid] ?? "Former user" : "—");
  const ext = data.extensions;
  const activeEsc = data.escalations.find((e) => e.active);
  const pendingExt = ext.find((e) => e.status === "PENDING");
  const priv = !!ws?.privileged;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); await refreshAll(); toast.success(ok); }
    catch (e) {
      const a = e as ApiError;
      toast.error(a.code === "STALE" ? "Someone else just changed this task" : "Couldn't do that", a.code === "STALE" ? "The page has the latest version now. Try again." : a.message);
      if (a.code === "STALE") void mutate();
    } finally { setBusy(null); }
  };
  const ver = () => t.version;

  const changeStatus = (to: string, label: string, reason?: boolean) => {
    if (!reason && to !== "COMPLETED") return run(to, () => api(`/tasks/${t.id}/status`, { body: { to, expectedVersion: ver() } }), `${label}: done`);
    if (to === "COMPLETED" && !reason) {
      const blocked = t.subtasks.total > 0 && !t.subtasks.readyForCompletion;
      if (!blocked) return run(to, () => api(`/tasks/${t.id}/status`, { body: { to, expectedVersion: ver() } }), "Task completed");
      return setSpec({
        title: "Required subtasks are still open", submitLabel: "Complete anyway", danger: true,
        intro: priv ? "As Admin or Leadership you can complete it anyway. The override and reason are recorded." : "Finish the required subtasks first, or ask Admin/Leadership to override.",
        fields: priv ? [{ name: "reason", label: "Reason for override", type: "textarea", required: true }] : [],
        run: async (v) => { if (!priv) throw new ApiError("BLOCKED", "Complete the required subtasks first."); await api(`/tasks/${t.id}/status`, { body: { to, expectedVersion: ver(), reason: v.reason, overrideIncompleteSubtasks: true } }); await refreshAll(); toast.success("Task completed"); },
      });
    }
    setSpec({ title: `${label} task`, submitLabel: label, fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }], run: async (v) => { await api(`/tasks/${t.id}/status`, { body: { to, expectedVersion: ver(), reason: v.reason } }); await refreshAll(); toast.success(`${label}: done`); } });
  };

  const escalate = () => setSpec({
    title: "Escalate task", submitLabel: "Escalate", danger: true,
    description: "Escalations are for urgent work that needs someone senior to step in. Waiting on a POC alone isn't an escalation.",
    fields: [
      { name: "level", label: "Escalate to", type: "radio", required: true, options: (ws?.escalationOwners ?? []).map((o) => ({ value: o.level, label: o.level, hint: o.name ? `${o.name}${o.active ? "" : " (inactive)"}` : "Not assigned" })), hint: "Pick the level that fits the urgency. You can go straight to L2 or L3." },
      { name: "reason", label: "What's blocked and what do you need?", type: "textarea", required: true },
    ],
    run: async (v) => { const r = await api<{ assignee: { name: string } }>(`/tasks/${t.id}/escalation`, { body: v }); await refreshAll(); toast.success(`Escalated to ${v.level}`, `${r.assignee.name} has been notified.`); },
  });
  const reassign = () => activeEsc && setSpec({
    title: "Reassign escalation", submitLabel: "Reassign", description: `Currently ${activeEsc.level}. The new owner is notified.`,
    fields: [
      { name: "level", label: "Move to", type: "radio", required: true, options: (ws?.escalationOwners ?? []).filter((o) => o.level !== activeEsc.level).map((o) => ({ value: o.level, label: o.level, hint: o.name ?? "Not assigned" })) },
      { name: "reason", label: "Reason", type: "textarea", required: true },
    ],
    run: async (v) => { await api(`/escalations/${activeEsc.id}/reassign`, { body: v }); await refreshAll(); toast.success(`Escalation moved to ${v.level}`); },
  });
  const resolve = () => activeEsc && setSpec({
    title: "Resolve escalation", submitLabel: "Resolve", intro: "This closes the escalation only. The task stays open until its own status is changed.",
    fields: [{ name: "remarks", label: "Resolution notes", type: "textarea", required: true }],
    run: async (v) => { await api(`/escalations/${activeEsc.id}/resolve`, { body: v }); await refreshAll(); toast.success("Escalation resolved"); },
  });
  const escUpdate = () => activeEsc && setSpec({
    title: "Post an escalation update", submitLabel: "Post update", fields: [{ name: "note", label: "Update", type: "textarea", required: true }],
    run: async (v) => { await api(`/escalations/${activeEsc.id}/respond`, { body: v }); await refreshAll(); toast.success("Update posted"); },
  });
  const requestExt = () => setSpec({
    title: "Request a deadline extension", submitLabel: "Send request",
    description: <>Current deadline <b>{fmtDate(t.deadline)}</b>. It stays in force until an approver accepts your request.</>,
    intro: t.status === "COMPLETED" ? <Alert tone="info">This task is already completed. An approved extension doesn&apos;t reopen it; it only corrects how the deadline counts in KPIs.</Alert> : undefined,
    fields: [
      { name: "requestedDeadline", label: "New deadline", type: "date", required: true, min: t.deadline ?? undefined },
      { name: "reason", label: "Reason", type: "textarea", required: true },
      { name: "withWaiver", label: "Also request a penalty waiver", type: "checkbox", hint: "Optional. A waiver is decided separately and can also be requested later." },
      { name: "waiverReason", label: "Why should the penalty be waived?", type: "textarea", required: true, showIf: (v) => v.withWaiver === true },
    ],
    run: async (v) => { await api(`/tasks/${t.id}/extensions`, { body: { requestedDeadline: v.requestedDeadline, reason: v.reason, waiverReason: v.withWaiver ? v.waiverReason : null } }); await refreshAll(); toast.success("Extension requested", v.withWaiver ? "Waiver requested too. They're decided separately." : "The deadline changes only if it's approved."); },
  });
  const requestWaiver = (extensionId?: string) => setSpec({
    title: "Request a penalty waiver", submitLabel: "Send request", description: "Approvers decide a waiver on its own. It never changes the deadline.",
    fields: [
      ...(extensionId ? [] : [{ name: "extensionId", label: "Related extension", type: "select" as const, options: ext.filter((e) => e.status !== "CANCELLED").map((e) => ({ value: e.id, label: `${fmtDate(e.previousDeadline)} → ${fmtDate(e.requestedDeadline)} (${e.status.toLowerCase()})` })), hint: "Optional. Leave empty if the waiver isn't about an extension." }]),
      { name: "reason", label: "Reason", type: "textarea", required: true },
    ],
    initial: extensionId ? { extensionId } : {},
    run: async (v) => { await api(`/tasks/${t.id}/waivers`, { body: { reason: v.reason, extensionId: v.extensionId || extensionId || null } }); await refreshAll(); toast.success("Waiver requested"); },
  });
  const decide = (kind: "extensions" | "waivers" | "transfers", rid: string, decision: "APPROVE" | "REJECT", label: string) => setSpec({
    title: `${decision === "APPROVE" ? "Approve" : "Reject"} ${label}`, submitLabel: decision === "APPROVE" ? "Approve" : "Reject", danger: decision === "REJECT",
    intro: kind === "extensions" && decision === "APPROVE" ? "Approving moves the deadline. Any waiver stays a separate decision." : kind === "waivers" ? "This decision doesn't affect the extension." : undefined,
    fields: [{ name: "reason", label: decision === "APPROVE" ? "Note" : "Reason", type: "textarea", required: decision === "REJECT" }],
    run: async (v) => { const r = await api<{ warnings?: string[] }>(`/${kind}/${rid}/decision`, { body: { decision, reason: v.reason || null } }); await refreshAll(); toast.success(`${label[0].toUpperCase()}${label.slice(1)} ${decision === "APPROVE" ? "approved" : "rejected"}`, r?.warnings?.join(" ")); },
  });
  const transfer = () => setSpec({
    title: "Transfer ownership", submitLabel: "Send transfer request", description: "The task stays with the current owner until the new owner accepts.",
    fields: [
      { name: "toUserId", label: "New owner", type: "select", required: true, options: (ws?.users ?? []).filter((u) => u.id !== t.owner.id).map((u) => ({ value: u.id, label: u.name })) },
      { name: "reason", label: "Reason", type: "textarea", required: true },
      ...(can.transferOverride ? [{ name: "override", label: "Reassign immediately (Admin override)", type: "checkbox" as const, hint: "Skips the recipient's acceptance. Recorded as an override." }] : []),
    ],
    run: async (v) => { await api(`/tasks/${t.id}/transfers`, { body: { toUserId: v.toUserId, reason: v.reason, override: v.override === true } }); await refreshAll(); toast.success(v.override ? "Owner changed" : "Transfer requested"); },
  });
  const share = () => setSpec({
    title: "Share this task", submitLabel: "Share", description: "They'll see this task only, not the owner's other work.",
    fields: [{ name: "userId", label: "Person", type: "select", required: true, options: (ws?.users ?? []).filter((u) => u.id !== t.owner.id && !data.access.some((a) => a.userId === u.id)).map((u) => ({ value: u.id, label: u.name })) }],
    run: async (v) => { await api(`/tasks/${t.id}/access`, { body: v }); await refreshAll(); toast.success("Task shared"); },
  });
  const promote = () => t.poc && setSpec({
    title: "Save POC to the shared list", submitLabel: "Send to L1", description: `L1 checks “${t.poc.name}” isn't a duplicate before it's added for everyone.`,
    fields: [{ name: "organisation", label: "Organisation", placeholder: "e.g. Amazon" }, { name: "contact", label: "Contact details", placeholder: "Email or phone" }],
    run: async (v) => { await api(`/pocs/${t.poc!.id}/promote`, { body: v }); toast.success("Sent to L1 for approval"); },
  });

  const statusOpts = (NEXT[t.status] ?? []).filter((o) => (o.to === "IN_PROGRESS" || o.to === "ON_HOLD" || o.to === "COMPLETED" ? (t.status === "COMPLETED" ? can.reopenCompleted : can.status) : can.reopenDropped));
  const more = [
    can.edit ? { label: "Edit details", icon: "edit" as const, onSelect: () => setEdit(true) } : null,
    can.transfer && !t.pendingTransfer ? { label: "Transfer ownership", icon: "users" as const, onSelect: transfer } : null,
    can.manageAccess ? { label: "Share with someone", icon: "userPlus" as const, onSelect: share } : null,
    can.drop && t.status !== "DROPPED" && t.status !== "COMPLETED" ? { label: "Drop task", icon: "ban" as const, onSelect: () => setSpec({ title: "Drop task", submitLabel: "Drop", danger: true, fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }], run: async (v) => { await api(`/tasks/${t.id}/status`, { body: { to: "DROPPED", expectedVersion: ver(), reason: v.reason } }); await refreshAll(); toast.success("Task dropped"); } }) } : null,
    !can.drop && can.requestCancellation && t.status !== "DROPPED" ? { label: "Request to drop", icon: "ban" as const, onSelect: () => setSpec({ title: "Request to drop", submitLabel: "Send request", fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }], run: async (v) => { await api(`/tasks/${t.id}/cancellation`, { body: { kind: "DROP", reason: v.reason } }); await refreshAll(); toast.success("Request sent"); } }) } : null,
    can.flag ? { label: t.flagged ? "Remove flag" : "Flag", icon: "flag" as const, onSelect: () => run("flag", () => api(`/tasks/${t.id}/flag`, { body: { flagged: !t.flagged } }), t.flagged ? "Flag removed" : "Task flagged") } : null,
    { label: can.softDelete ? "Move to Bin" : "Request removal", icon: "trash" as const, danger: true, onSelect: () => setBin(true), disabled: t.softDeleted },
  ];

  return (
    <div className="space-y-6">
      <Link href="/tasks" className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-brand"><Icon name="chevronLeft" size={16} />Tasks</Link>
      {t.softDeleted && <Alert tone="warning" action={can.restore ? <Link href="/bin" className="font-semibold underline">Open Recycle Bin</Link> : undefined}>This task is in the Recycle Bin.</Alert>}

      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-500 tabular">{t.id}{t.seriesId && <> · recurring #{t.occurrenceNumber}</>}</p>
            <h2 className="mt-1 flex items-start gap-2 text-xl font-extrabold leading-snug sm:text-2xl">
              {t.flagged && <Icon name="flag" size={20} className="mt-1 text-red-600" label="Flagged" />}
              {t.starred && <Icon name="star" size={20} className="mt-1 text-amber-500" label="Starred" />}
              <span>{t.name}</span>
            </h2>
            <div className="mt-3 flex flex-wrap items-center gap-2"><StatusBadge status={t.status} /><PriorityBadge p={t.priority} /><LevelBadge level={t.escalationLevel} />{t.pocType && <PocBadge type={t.pocType as PocType} name={t.pendingFrom} />}{t.timeliness === "OVERDUE" && <Badge tone="red" icon="alert">Overdue {t.daysOverdue}d</Badge>}{t.timeliness === "LATE" && <Badge tone="amber">Completed late</Badge>}</div>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            {statusOpts.map((o, i) => <Button key={o.to} variant={i === 0 ? "primary" : "secondary"} icon={o.icon} busy={busy === o.to} onClick={() => changeStatus(o.to, o.label, o.reason)}>{o.label}</Button>)}
            {can.star && <Button icon="star" busy={busy === "star"} onClick={() => run("star", () => api(`/tasks/${t.id}/star`, { body: { starred: !t.starred } }), t.starred ? "Unstarred" : "Starred")}>{t.starred ? "Unstar" : "Star"}</Button>}
            <Menu label="More actions" items={more} />
          </div>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-slate-100 pt-5 text-sm sm:grid-cols-3 xl:grid-cols-6">
          <Info label="Owner" value={t.owner.name} />
          <Info label="Channel" value={t.channel.name} />
          <Info label="Deadline" value={<DeadlineText t={t} />} sub={t.originalDeadline !== t.deadline ? `Originally ${fmtDate(t.originalDeadline)}` : undefined} />
          <Info label="Follow-up" value={t.followupDate ? fmtDate(t.followupDate) : "—"} />
          <Info label="Project" value={t.project ? <Link className="text-brand hover:underline" href={`/projects/${t.project.id}`}>{t.project.name}</Link> : "—"} />
          <Info label="Assigned" value={fmtDate(t.assignedDate)} sub={t.completedAt ? `Completed ${fmtDate(t.completedAt)}` : t.agingDays != null ? `${t.agingDays} days old` : undefined} />
        </dl>
        {t.pendingTransfer && <Alert tone="info">Transfer to <b>{n(t.pendingTransfer.toUserId)}</b> is waiting for them to accept. The owner doesn&apos;t change until then.</Alert>}
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {/* Escalation */}
          <Card>
            <CardHeader title="Escalation" subtitle={activeEsc ? `Assigned to ${n(activeEsc.assigneeId)} (${activeEsc.level})` : "L0 · not escalated"}
              action={activeEsc ? (
                <div className="flex flex-wrap gap-2">
                  {can.reassignEscalation && <Button size="sm" icon="refresh" onClick={reassign}>Reassign</Button>}
                  {can.resolveEscalation && <Button size="sm" variant="primary" icon="check" onClick={resolve}>Resolve</Button>}
                  <Button size="sm" variant="ghost" onClick={escUpdate}>Post update</Button>
                </div>
              ) : can.escalate ? <Button size="sm" variant="danger" icon="flame" onClick={escalate}>Escalate</Button> : null} />
            {data.escalations.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">No escalations on this task.</p> : (
              <ul className="divide-y divide-slate-100">
                {data.escalations.map((e) => (
                  <li key={e.id} className="px-5 py-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><LevelBadge level={e.level} /><Badge tone={e.active ? "red" : "green"}>{e.active ? "Active" : "Resolved"}</Badge><span className="text-slate-500">raised by {n(e.triggeredById)} · {fmtRelative(e.triggeredAt)}</span></div>
                    {e.reason && <p className="mt-2 text-slate-700">{e.reason}</p>}
                    {e.levelChanges.length > 1 && <p className="mt-1 text-xs text-slate-500">Path: {e.levelChanges.map((c) => c.toLevel).join(" → ")}</p>}
                    {e.resolutionRemarks && <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">Resolved by {n(e.resolvedById)}: {e.resolutionRemarks}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Extensions & waivers */}
          <Card>
            <CardHeader title="Extension requests & waivers" subtitle="The deadline only changes when an extension is approved. Waivers are decided on their own."
              action={<div className="flex flex-wrap gap-2">
                {can.requestExtension && !pendingExt && t.status !== "DROPPED" && <Button size="sm" icon="calendar" onClick={requestExt}>Request extension</Button>}
                {can.requestWaiver && <Button size="sm" variant="ghost" onClick={() => requestWaiver()}>Request waiver</Button>}
              </div>} />
            {ext.length === 0 && data.waivers.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">No requests yet.</p> : (
              <ul className="divide-y divide-slate-100">
                {ext.map((e) => {
                  const ws2 = data.waivers.filter((w) => w.extensionId === e.id);
                  return (
                    <li key={e.id} className="px-5 py-4 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <b>Extension</b><span className="tabular">{fmtDate(e.previousDeadline)} → {fmtDate(e.requestedDeadline)}</span><ReqBadge s={e.status} />{e.afterCompletion && <Badge tone="violet">After completion</Badge>}
                        <span className="text-slate-500">by {n(e.requestedById)} · {fmtRelative(e.requestedAt)}</span>
                      </div>
                      <p className="mt-1 text-slate-700">{e.reason}</p>
                      {e.decidedById && <p className="mt-1 text-xs text-slate-500">{e.status === "APPROVED" ? "Approved" : "Decided"} by {n(e.decidedById)}{e.decisionReason ? `: ${e.decisionReason}` : ""}</p>}
                      {e.status === "PENDING" && can.decideExtension && e.requestedById !== me?.me.id && (
                        <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" onClick={() => decide("extensions", e.id, "APPROVE", "extension")}>Approve extension</Button><Button size="sm" onClick={() => decide("extensions", e.id, "REJECT", "extension")}>Reject</Button></div>
                      )}
                      {ws2.map((w) => <WaiverRow key={w.id} w={w} n={n} canDecide={can.decideWaiver && w.requestedById !== me?.me.id && e.requestedById !== me?.me.id} onDecide={(d) => decide("waivers", w.id, d, "waiver")} />)}
                      {can.requestWaiver && e.status !== "CANCELLED" && !ws2.some((w) => w.status === "PENDING" || w.status === "APPROVED") && <button className="mt-2 text-xs font-semibold text-brand hover:underline" onClick={() => requestWaiver(e.id)}>Request a waiver for this extension</button>}
                    </li>
                  );
                })}
                {data.waivers.filter((w) => !w.extensionId).map((w) => <li key={w.id} className="px-5 py-4 text-sm"><WaiverRow w={w} n={n} canDecide={can.decideWaiver && w.requestedById !== me?.me.id} onDecide={(d) => decide("waivers", w.id, d, "waiver")} standalone /></li>)}
              </ul>
            )}
          </Card>

          {/* Description */}
          <Card>
            <CardHeader title="Details" action={can.edit ? <Button size="sm" icon="edit" onClick={() => setEdit(true)}>Edit</Button> : null} />
            <div className="space-y-4 px-5 pb-5 text-sm">
              <div><p className="text-xs font-bold uppercase tracking-wide text-slate-400">Description</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{t.description || "—"}</p></div>
              <div><p className="text-xs font-bold uppercase tracking-wide text-slate-400">Remarks</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{t.remarks || "—"}</p></div>
              {t.outputLink && <a href={t.outputLink} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 font-semibold text-brand hover:underline"><Icon name="link" size={16} />Output link</a>}
            </div>
          </Card>

          {/* History */}
          <Card>
            <CardHeader title="History" subtitle="Every change, oldest first. History can't be edited." />
            {data.history.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">History is visible to people with access to this task.</p> : (
              <ol className="relative mx-5 mb-5 border-l-2 border-slate-100">
                {data.history.map((h) => (
                  <li key={h.id} className="ml-4 py-2.5 text-sm">
                    <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-slate-300" aria-hidden />
                    <p><b>{h.actorName}</b> {EVENT_LABEL[h.eventType] ?? h.eventType.toLowerCase().replace(/_/g, " ")}{h.result !== "SUCCESS" && <Badge tone="red">{h.result.toLowerCase()}</Badge>}</p>
                    <HistoryDetail h={h} n={n} />
                    <p className="text-xs text-slate-400">{new Date(h.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Pending From" subtitle={t.pocType ? `Waiting since ${t.pendingSince ? fmtRelative(t.pendingSince) : "—"}` : "Not waiting on anyone"} action={can.edit ? <Button size="sm" onClick={() => setEdit(true)}>{t.pocType ? "Change" : "Set"}</Button> : null} />
            <div className="px-5 pb-5 text-sm">
              {t.pocType ? (
                <>
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{POC_LABEL[t.pocType as PocType]}</p>
                  <p className="mt-0.5 text-base font-bold">{t.pendingFrom}</p>
                  <p className="text-xs text-slate-500">{t.poc?.isRegistry ? "Saved POC" : "Custom POC, kept on this task only"}</p>
                  {t.poc && !t.poc.isRegistry && can.edit && <button onClick={promote} className="mt-2 text-xs font-semibold text-brand hover:underline">Ask L1 to add it to the saved list</button>}
                </>
              ) : <p className="text-slate-500">Mark the task as pending to track who you&apos;re waiting on.</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="People with access" subtitle="Besides the owner, Admin and Leadership." action={can.manageAccess ? <Button size="sm" icon="userPlus" onClick={share}>Share</Button> : null} />
            <ul className="px-5 pb-4 text-sm">
              <li className="flex items-center justify-between py-1.5"><span className="font-semibold">{t.owner.name}</span><Badge tone="blue">Owner</Badge></li>
              {data.access.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0 truncate">{a.name}</span>
                  <span className="flex items-center gap-1"><Badge>{a.reason.toLowerCase().replace(/_/g, " ")}</Badge>
                    {can.manageAccess && <button aria-label={`Remove ${a.name}'s access`} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => run(`rm-${a.id}`, () => api(`/tasks/${t.id}/access/${a.id}`, { method: "DELETE" }), "Access removed")}><Icon name="x" size={14} /></button>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Subtasks data={data} onAdd={() => setSpec({
            title: "Add subtask", submitLabel: "Add",
            fields: [{ name: "title", label: "Title", required: true }, { name: "ownerId", label: "Owner", type: "select", options: (ws?.users ?? []).map((u) => ({ value: u.id, label: u.name })), hint: "Optional. They'll see this task (only this one)." }, { name: "dueDate", label: "Due date", type: "date" }],
            run: async (v) => { await api(`/tasks/${t.id}/subtasks`, { body: { title: v.title, ownerId: v.ownerId || null, dueDate: v.dueDate || null } }); await refreshAll(); toast.success("Subtask added"); },
          })} />
          {data.transfers.length > 0 && (
            <Card>
              <CardHeader title="Transfers" />
              <ul className="divide-y divide-slate-100 text-sm">
                {data.transfers.map((tr) => (
                  <li key={tr.id} className="px-5 py-3">
                    <p>{n(tr.fromUserId)} → <b>{n(tr.toUserId)}</b> <ReqBadge s={tr.status} />{tr.adminOverride && <Badge tone="violet">Override</Badge>}</p>
                    <p className="text-xs text-slate-500">{tr.reason}{tr.rejectionReason ? ` · Rejected: ${tr.rejectionReason}` : ""}</p>
                    {tr.status === "PENDING" && tr.toUserId === me?.me.id && (
                      <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" onClick={() => decide("transfers", tr.id, "APPROVE", "transfer")}>Accept</Button><Button size="sm" onClick={() => decide("transfers", tr.id, "REJECT", "transfer")}>Reject</Button></div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <ActionModal spec={spec} onClose={() => setSpec(null)} />
      {edit && <EditTaskModal detail={data} onClose={() => setEdit(false)} />}
      <BinModal task={bin ? t : null} privileged={can.softDelete} onClose={() => setBin(false)} />
    </div>
  );
}

function Info({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return <div><dt className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</dt><dd className="mt-0.5 font-semibold text-slate-800">{value}</dd>{sub && <dd className="text-xs text-slate-500">{sub}</dd>}</div>;
}

const ReqBadge = ({ s }: { s: string }) => <Badge tone={s === "APPROVED" ? "green" : s === "REJECTED" ? "red" : s === "PENDING" ? "amber" : "slate"}>{s.charAt(0) + s.slice(1).toLowerCase()}</Badge>;

function WaiverRow({ w, n, canDecide, onDecide, standalone }: { w: Detail["waivers"][number]; n: (id: string | null) => string; canDecide: boolean; onDecide: (d: "APPROVE" | "REJECT") => void; standalone?: boolean }) {
  return (
    <div className={cx(!standalone && "mt-3 rounded-xl border border-violet-100 bg-violet-50/40 p-3")}>
      <div className="flex flex-wrap items-center gap-2"><b>Waiver</b><ReqBadge s={w.status} />{standalone && <Badge>No extension</Badge>}<span className="text-slate-500">by {n(w.requestedById)}</span></div>
      <p className="mt-1 text-slate-700">{w.reason}</p>
      {w.decidedById && <p className="mt-1 text-xs text-slate-500">Decided by {n(w.decidedById)}{w.decisionReason ? `: ${w.decisionReason}` : ""}</p>}
      {w.status === "PENDING" && canDecide && <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" onClick={() => onDecide("APPROVE")}>Approve waiver</Button><Button size="sm" onClick={() => onDecide("REJECT")}>Reject</Button></div>}
    </div>
  );
}

function HistoryDetail({ h, n }: { h: Detail["history"][number]; n: (id: string) => string }) {
  const prev = h.previousValue as Record<string, unknown> | string | number | null;
  const next = h.newValue as Record<string, unknown> | string | number | null;
  const lines: string[] = [];
  if (h.reason) lines.push(h.reason);
  if (typeof prev !== "object" && typeof next !== "object" && (prev != null || next != null)) lines.push(`${prev ?? "—"} → ${next ?? "—"}`);
  else if (prev && next && typeof prev === "object" && typeof next === "object") {
    for (const k of Object.keys(next).slice(0, 4)) {
      const a = prev[k], b = next[k];
      if (a === undefined || typeof b === "object") continue;
      const fmt = (x: unknown) => (k.toLowerCase().endsWith("id") && typeof x === "string" ? n(x) : String(x ?? "—"));
      lines.push(`${k}: ${fmt(a)} → ${fmt(b)}`);
    }
  }
  if (!lines.length) return null;
  return <p className="text-xs text-slate-500">{lines.join(" · ")}</p>;
}

function Subtasks({ data, onAdd }: { data: Detail; onAdd: () => void }) {
  const can = data.permissions;
  const toggle = async (s: Detail["subtasks"][number]) => {
    try { await api(`/subtasks/${s.id}/status`, { body: { to: s.status === "COMPLETED" ? "IN_PROGRESS" : "COMPLETED", expectedVersion: s.version } }); await refreshAll(); }
    catch (e) { toast.error("Couldn't update the subtask", (e as Error).message); }
  };
  return (
    <Card>
      <CardHeader title="Subtasks" subtitle={data.subtasks.length ? `${data.task.subtasks.done}/${data.task.subtasks.total} done` : undefined} action={can.manageSubtasks ? <Button size="sm" icon="plus" onClick={onAdd}>Add</Button> : null} />
      {data.subtasks.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">No subtasks.</p> : (
        <ul className="px-3 pb-3 text-sm">
          {data.subtasks.map((s) => (
            <li key={s.id} className="flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-slate-50">
              <input type="checkbox" aria-label={`Mark ${s.title} ${s.status === "COMPLETED" ? "not done" : "done"}`} className="mt-0.5 h-5 w-5 rounded border-slate-300 accent-[#2563EB]" checked={s.status === "COMPLETED"} onChange={() => toggle(s)} />
              <span className="min-w-0"><span className={cx("block font-medium", s.status === "COMPLETED" && "text-slate-400 line-through")}>{s.title}</span><span className="block text-xs text-slate-500">{s.owner?.name ?? "Unassigned"}{s.dueDate ? ` · due ${fmtDate(s.dueDate, { day: "numeric", month: "short" })}` : ""}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
