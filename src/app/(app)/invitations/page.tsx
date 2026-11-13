"use client";
import { Suspense, useEffect, useState } from "react";
import type { listInvitations } from "@/domain/invitations";
import { api, ApiError, refreshAll, useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { useDebounced, useUrlState } from "@/components/useUrlState";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, fmtDate, fmtRelative, Icon, INVITE_STATUS, Menu, Modal, PageHeader, Pagination, SearchInput, Segmented, Skeleton } from "@/components/ui";
import { CopyButton, InviteModal } from "@/components/team/InviteModal";
import { toast } from "@/components/toast";

type List = Awaited<ReturnType<typeof listInvitations>>;
type Row = List["rows"][number];

export default function InvitationsPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Invitations /></Suspense>;
}

function expiryText(r: Row) {
  if (r.status === "ACCEPTED") return `Accepted ${fmtRelative(r.acceptedAt).toLowerCase()}`;
  if (r.status === "REVOKED") return `Revoked ${fmtRelative(r.revokedAt).toLowerCase()}`;
  if (r.status === "EXPIRED") return `Expired ${fmtRelative(r.expiresAt).toLowerCase()}`;
  return `Expires ${fmtRelative(r.expiresAt)}`;
}

function Invitations() {
  const { data: me, can } = useMe();
  const [f, set] = useUrlState(["q", "status", "page"] as const);
  const [q, setQ] = useState(f.q);
  const dq = useDebounced(q);
  useEffect(() => { if (dq !== f.q) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = new URLSearchParams(Object.entries({ q: f.q, status: f.status, page: f.page }).filter(([, v]) => v) as [string, string][]).toString();
  const { data, error, isLoading, mutate } = useApi<List>(can("invitations.view") ? `/invitations?${qs}` : null, { refreshInterval: 30000 });
  const [inviting, setInviting] = useState(false);
  const [revoke, setRevoke] = useState<Row | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  // Tick so cooldowns and "expires in" stay current without refetching.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  if (me && !can("invitations.view")) return <Card><EmptyState icon="lock" title="You don't have access to invitations" /></Card>;

  async function resend(r: Row) {
    setBusyId(r.id);
    try {
      const res = await api<{ ok: boolean; error?: string; link?: string }>(`/invitations/${r.id}/resend`, { body: {} });
      await refreshAll();
      if (!res.ok) toast.error("Invitation renewed, but the email failed", res.error);
      else toast.success("Invitation resent", `${r.email} has a new link valid for ${data?.ttlDays ?? 7} days.`);
      if (res.link) setLink({ email: r.email, url: res.link });
    } catch (e) {
      toast.error("Couldn't resend", (e as ApiError).message);
    } finally {
      setBusyId(null);
    }
  }

  const waitFor = (r: Row) => Math.max(0, (data?.resendCooldownSeconds ?? 60) - Math.floor((Date.now() - Date.parse(String(r.lastSentAt))) / 1000));

  const actions = (r: Row) => [
    r.canResend ? { label: waitFor(r) > 0 ? `Resend in ${waitFor(r)}s` : r.status === "EXPIRED" ? "Renew & resend" : "Resend invitation", icon: "refresh" as const, disabled: waitFor(r) > 0 || busyId === r.id, onSelect: () => resend(r) } : null,
    r.canRevoke ? { label: "Revoke invitation", icon: "ban" as const, danger: true, onSelect: () => setRevoke(r) } : null,
  ];

  return (
    <div>
      <PageHeader title="Invitations" description={`Invite people by email. Each link works once and expires after ${data?.ttlDays ?? 7} days; resending issues a new link and cancels the old one.`}
        actions={can("invitations.send") && <Button variant="primary" icon="send" onClick={() => setInviting(true)}>Invite people</Button>} />

      {me?.mailMode === "outbox" && (
        <Alert tone="info">Email delivery isn&apos;t configured, so invitations go to the <a href="/emails" className="font-semibold underline">email outbox</a>. Set <code className="rounded bg-white/70 px-1">SMTP_HOST</code> to send real emails.</Alert>
      )}

      <Card className="mt-4">
        <div className="flex flex-col gap-3 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <Segmented label="Status" value={f.status || "ALL"} onChange={(v) => set({ status: v === "ALL" ? null : v })}
            options={(["ALL", "PENDING", "ACCEPTED", "EXPIRED", "REVOKED"] as const).map((s) => ({ value: s, label: s === "ALL" ? "All" : INVITE_STATUS[s].label, count: data?.counts[s] }))} />
          <SearchInput value={q} onChange={setQ} placeholder="Search by email" className="lg:w-72" label="Search invitations" />
        </div>

        {error && <div className="px-5"><Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert></div>}
        {isLoading && !data && <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
        {data && data.rows.length === 0 && (
          f.q || f.status
            ? <EmptyState icon="search" title={`No ${f.status ? INVITE_STATUS[f.status].label.toLowerCase() : ""} invitations${f.q ? ` matching "${f.q}"` : ""}`} action={<Button onClick={() => { setQ(""); set({ q: null, status: null }); }}>Show all</Button>} />
            : <EmptyState icon="mail" title="No invitations yet" body="Invite teammates and track whether they've joined." action={can("invitations.send") && <Button variant="primary" icon="send" onClick={() => setInviting(true)}>Invite people</Button>} />
        )}

        {data && data.rows.length > 0 && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-y border-slate-100 bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr><th scope="col" className="px-5 py-3">Email</th><th scope="col" className="px-3 py-3">Role</th><th scope="col" className="px-3 py-3">Status</th><th scope="col" className="px-3 py-3">Invited by</th><th scope="col" className="px-3 py-3">Sent</th><th scope="col" className="px-3 py-3">Expiry</th><th scope="col" className="px-5 py-3"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3.5">
                        <p className="font-semibold text-slate-900">{r.email}</p>
                        {!r.lastEmailOk && r.status !== "ACCEPTED" && r.status !== "REVOKED" && <p className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-red-600"><Icon name="alert" size={13} />Last email failed. Resend it.</p>}
                      </td>
                      <td className="px-3 py-3.5"><Badge>{r.role.name}</Badge></td>
                      <td className="px-3 py-3.5"><Badge tone={INVITE_STATUS[r.status].tone} icon={INVITE_STATUS[r.status].icon}>{INVITE_STATUS[r.status].label}</Badge></td>
                      <td className="px-3 py-3.5 text-slate-600">{r.invitedBy}</td>
                      <td className="px-3 py-3.5 text-slate-600"><span title={fmtDate(r.lastSentAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}>{fmtRelative(r.lastSentAt)}</span>{r.sentCount > 1 && <span className="ml-1 text-xs text-slate-400">({r.sentCount}×)</span>}</td>
                      <td className={`px-3 py-3.5 ${r.status === "EXPIRED" ? "font-semibold text-amber-700" : "text-slate-600"}`}>{expiryText(r)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1">
                          {r.canResend && <Button size="sm" icon="refresh" busy={busyId === r.id} disabled={waitFor(r) > 0} onClick={() => resend(r)}>{waitFor(r) > 0 ? `${waitFor(r)}s` : "Resend"}</Button>}
                          <Menu label={`More actions for ${r.email}`} items={actions(r).slice(1)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-3 px-4 md:hidden">
              {data.rows.map((r) => (
                <li key={r.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="truncate font-semibold">{r.email}</p><p className="text-xs text-slate-500">{r.role.name} · by {r.invitedBy}</p></div>
                    <Menu label={`Actions for ${r.email}`} items={actions(r)} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2"><Badge tone={INVITE_STATUS[r.status].tone} icon={INVITE_STATUS[r.status].icon}>{INVITE_STATUS[r.status].label}</Badge><span className="text-xs text-slate-500">{expiryText(r)}</span></div>
                  {!r.lastEmailOk && r.status !== "ACCEPTED" && r.status !== "REVOKED" && <p className="mt-2 text-xs font-semibold text-red-600">Last email failed. Resend it.</p>}
                </li>
              ))}
            </ul>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>

      <InviteModal open={inviting} onClose={() => setInviting(false)} />
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} title="Revoke invitation?" confirmLabel="Revoke"
        body={<>The link sent to <b>{revoke?.email}</b> will stop working immediately. You can invite them again later.</>}
        onConfirm={async () => { await api(`/invitations/${revoke!.id}/revoke`, { body: {} }); await refreshAll(); toast.success("Invitation revoked", revoke!.email); }} />
      <Modal open={!!link} onClose={() => setLink(null)} title="New invitation link" description={`Email isn't configured, so share this link with ${link?.email} directly. It works once.`} size="sm"
        footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
        <div className="flex flex-col gap-3"><code className="break-all rounded-xl bg-slate-50 p-3 text-xs">{link?.url}</code>{link && <CopyButton text={link.url} />}</div>
      </Modal>
    </div>
  );
}
