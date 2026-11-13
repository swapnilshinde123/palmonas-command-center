"use client";
import { Suspense, useEffect, useState } from "react";
import { api, refreshAll, useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { useDebounced, useUrlState } from "@/components/useUrlState";
import { Alert, Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, Field, fmtDate, fmtRelative, Menu, PageHeader, Pagination, SearchInput, Segmented, Select, Skeleton, Textarea, USER_STATUS } from "@/components/ui";
import { InviteModal } from "@/components/team/InviteModal";
import { UserModal, type UserRow } from "@/components/team/UserModal";
import { toast } from "@/components/toast";

interface List { rows: UserRow[]; total: number; page: number; pageSize: number; counts: Record<string, number> }
type StatusAction = { user: UserRow; to: "ACTIVE" | "SUSPENDED" | "DEACTIVATED" } | null;

export default function UsersPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Users /></Suspense>;
}

function Users() {
  const { data: me, can } = useMe();
  const [f, set] = useUrlState(["q", "roleId", "status", "sort", "page"] as const);
  const [q, setQ] = useState(f.q);
  const dq = useDebounced(q);
  useEffect(() => { if (dq !== f.q) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setQ(f.q), [f.q]);

  const [sortKey, sortDir] = (f.sort || "name:asc").split(":");
  const qs = new URLSearchParams(Object.entries({ q: f.q, roleId: f.roleId, status: f.status, page: f.page, sort: sortKey, dir: sortDir }).filter(([, v]) => v) as [string, string][]).toString();
  const { data, error, isLoading, mutate } = useApi<List>(can("users.view") ? `/users?${qs}` : null);
  const { data: roles } = useApi<{ id: string; name: string }[]>(can("roles.view") ? "/roles" : null);

  const [edit, setEdit] = useState<UserRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [del, setDel] = useState<UserRow | null>(null);
  const [status, setStatus] = useState<StatusAction>(null);

  if (me && !can("users.view")) return <Card><EmptyState icon="lock" title="You don't have access to the team directory" body="Ask an admin if you need to manage team members." /></Card>;
  const filtered = !!(f.q || f.roleId || f.status);

  const actions = (u: UserRow) => [
    u.canEdit ? { label: "Edit details", icon: "edit" as const, onSelect: () => setEdit(u) } : null,
    u.canChangeStatus && u.status !== "ACTIVE" ? { label: "Activate", icon: "play" as const, onSelect: () => setStatus({ user: u, to: "ACTIVE" }) } : null,
    u.canChangeStatus && u.status !== "SUSPENDED" ? { label: "Suspend", icon: "pause" as const, onSelect: () => setStatus({ user: u, to: "SUSPENDED" }) } : null,
    u.canChangeStatus && u.status !== "DEACTIVATED" ? { label: "Deactivate", icon: "ban" as const, onSelect: () => setStatus({ user: u, to: "DEACTIVATED" }) } : null,
    u.canDelete ? { label: "Delete user", icon: "trash" as const, danger: true, onSelect: () => setDel(u) } : null,
  ];

  return (
    <div>
      <PageHeader title="Users" description="Everyone on the team. Invite people to sign in with Google, or add them directly. Admins set the L1/L2/L3 escalation owners here."
        actions={<>
          {can("invitations.send") && <Button icon="send" onClick={() => setInviting(true)}>Invite people</Button>}
          {can("users.create") && <Button variant="primary" icon="userPlus" onClick={() => setAdding(true)}>Add user</Button>}
        </>} />

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:p-5 lg:flex-row lg:items-center">
          <SearchInput value={q} onChange={setQ} placeholder="Search by name, email or title" className="lg:w-80" label="Search users" />
          <div className="grid flex-1 grid-cols-2 gap-3 lg:flex lg:justify-end">
            <Select aria-label="Filter by role" value={f.roleId} onChange={(e) => set({ roleId: e.target.value || null })} className="lg:w-44">
              <option value="">All roles</option>{(roles ?? me?.assignableRoles)?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <Select aria-label="Sort" value={f.sort || "name:asc"} onChange={(e) => set({ sort: e.target.value === "name:asc" ? null : e.target.value })} className="lg:w-48">
              <option value="name:asc">Name A–Z</option><option value="name:desc">Name Z–A</option><option value="createdAt:desc">Newest first</option><option value="createdAt:asc">Oldest first</option><option value="lastLoginAt:desc">Recently active</option><option value="role:asc">Role</option>
            </Select>
          </div>
        </div>
        <div className="px-4 pt-4 sm:px-5">
          <Segmented label="Status" value={f.status || "ALL"} onChange={(v) => set({ status: v === "ALL" ? null : v })}
            options={[{ value: "ALL", label: "All", count: data?.counts.ALL }, { value: "ACTIVE", label: "Active", count: data?.counts.ACTIVE ?? 0 }, { value: "SUSPENDED", label: "Suspended", count: data?.counts.SUSPENDED ?? 0 }, { value: "DEACTIVATED", label: "Deactivated", count: data?.counts.DEACTIVATED ?? 0 }]} />
        </div>

        {error && <div className="px-5"><Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert></div>}
        {isLoading && !data && <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="flex items-center gap-3"><Skeleton className="h-10 w-10 rounded-full" /><Skeleton className="h-4 flex-1" /><Skeleton className="hidden h-4 w-24 sm:block" /></div>)}</div>}
        {data && data.rows.length === 0 && (
          filtered
            ? <EmptyState icon="search" title="No users match these filters" body="Try a different search or clear the filters." action={<Button onClick={() => { setQ(""); set({ q: null, roleId: null, status: null }); }}>Clear filters</Button>} />
            : <EmptyState icon="users" title="No users yet" body="Invite your team to get started." action={can("invitations.send") && <Button variant="primary" icon="send" onClick={() => setInviting(true)}>Invite people</Button>} />
        )}

        {data && data.rows.length > 0 && (
          <>
            {/* Desktop table */}
            <div className="mt-4 hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-y border-slate-100 bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr><th scope="col" className="px-5 py-3">User</th><th scope="col" className="px-3 py-3">Code</th><th scope="col" className="px-3 py-3">Role</th><th scope="col" className="px-3 py-3">Escalation</th><th scope="col" className="px-3 py-3">Status</th><th scope="col" className="px-3 py-3">Last active</th><th scope="col" className="px-3 py-3">Joined</th><th scope="col" className="px-5 py-3"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((u) => (
                    <tr key={u.id} className="transition hover:bg-slate-50/60">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.name} />
                          <div className="min-w-0"><p className="truncate font-bold text-slate-900">{u.name}{u.isSelf && <span className="ml-2 text-xs font-semibold text-slate-400">(you)</span>}</p><p className="truncate text-slate-500">{u.email}</p>{u.title && <p className="truncate text-xs text-slate-400">{u.title}</p>}</div>
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs font-bold text-slate-600">{u.code}</td>
                      <td className="px-3 py-3"><Badge tone={u.role.key === "owner" ? "violet" : u.role.tier === "ADMIN" ? "blue" : u.role.tier === "LEADERSHIP" ? "green" : "slate"}>{u.role.name}</Badge></td>
                      <td className="px-3 py-3">{u.escalationLevel ? <Badge tone="red" icon="flame">{u.escalationLevel}</Badge> : <span className="text-xs text-slate-400">—</span>}</td>
                      <td className="px-3 py-3"><Badge tone={USER_STATUS[u.status].tone} dot>{USER_STATUS[u.status].label}</Badge></td>
                      <td className="px-3 py-3 text-slate-600">{fmtRelative(u.lastLoginAt)}</td>
                      <td className="px-3 py-3 text-slate-600">{fmtDate(u.createdAt)}</td>
                      <td className="px-5 py-3 text-right"><Menu label={`Actions for ${u.name}`} items={actions(u)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <ul className="mt-4 space-y-3 px-4 md:hidden">
              {data.rows.map((u) => (
                <li key={u.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-start gap-3">
                    <Avatar name={u.name} />
                    <div className="min-w-0 flex-1"><p className="truncate font-bold">{u.name}{u.isSelf && <span className="ml-1 text-xs text-slate-400">(you)</span>}</p><p className="truncate text-sm text-slate-500">{u.email}</p></div>
                    <Menu label={`Actions for ${u.name}`} items={actions(u)} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2"><Badge tone={u.role.key === "owner" ? "violet" : "slate"}>{u.role.name}</Badge><Badge tone={USER_STATUS[u.status].tone} dot>{USER_STATUS[u.status].label}</Badge><span className="text-xs text-slate-500">Active {fmtRelative(u.lastLoginAt).toLowerCase()}</span></div>
                </li>
              ))}
            </ul>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>

      <UserModal open={adding || !!edit} user={edit} onClose={() => { setAdding(false); setEdit(null); }} />
      <InviteModal open={inviting} onClose={() => setInviting(false)} />
      <StatusDialog action={status} onClose={() => setStatus(null)} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title="Delete user?" confirmLabel="Delete user" typeToConfirm={del?.email}
        body={<>This permanently removes <b>{del?.name}</b> and signs them out everywhere. Their past activity stays in the activity log. To keep the account but block access, deactivate it instead.</>}
        onConfirm={async (typed) => { await api(`/users/${del!.id}`, { method: "DELETE", body: { confirmEmail: typed } }); await refreshAll(); toast.success("User deleted", del!.email); }} />
    </div>
  );
}

function StatusDialog({ action, onClose }: { action: StatusAction; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => { setReason(""); setErr(undefined); }, [action]);
  if (!action) return null;
  const { user, to } = action;
  const copy = {
    ACTIVE: { title: `Activate ${user.name}?`, body: "They'll be able to sign in again. Any sign-in lockout is cleared.", cta: "Activate" },
    SUSPENDED: { title: `Suspend ${user.name}?`, body: "They're signed out and can't sign in until reactivated. Use this for temporary leave or investigations.", cta: "Suspend" },
    DEACTIVATED: { title: `Deactivate ${user.name}?`, body: "Use this when someone leaves. The account is kept for records but can't sign in.", cta: "Deactivate" },
  }[to];
  return (
    <ConfirmDialog open title={copy.title} body={copy.body} confirmLabel={copy.cta} tone={to === "ACTIVE" ? "primary" : "danger"} onClose={onClose}
      onConfirm={async () => {
        if (to !== "ACTIVE" && !reason.trim()) { setErr("Say why, so other admins know."); throw new Error("A reason is required."); }
        await api(`/users/${user.id}/status`, { body: { status: to, reason } });
        await refreshAll();
        toast.success(`${user.name} is now ${USER_STATUS[to].label.toLowerCase()}`);
      }}>
      {to !== "ACTIVE" && <div className="mt-4"><Field label="Reason" required error={err}>{(id, d, inv) => <Textarea id={id} aria-describedby={d} invalid={inv} value={reason} onChange={(e) => { setReason(e.target.value); setErr(undefined); }} placeholder="e.g. Contract ended on 30 June" />}</Field></div>}
    </ConfirmDialog>
  );
}
