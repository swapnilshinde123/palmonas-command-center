"use client";
import { Fragment, Suspense, useEffect, useState } from "react";
import type { listRoles } from "@/domain/roles";
import { api, ApiError, refreshAll, useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { useUrlState } from "@/components/useUrlState";
import { Alert, Badge, Button, Card, ConfirmDialog, cx, EmptyState, Field, Icon, Input, Modal, PageHeader, Segmented, Select, Skeleton } from "@/components/ui";
import { toast } from "@/components/toast";

type Role = Awaited<ReturnType<typeof listRoles>>[number];
const TIER_TEXT: Record<string, string> = { ADMIN: "sees all tasks · admin", LEADERSHIP: "sees all tasks · approves", MEMBER: "own & shared tasks" };

export default function RolesPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Roles /></Suspense>;
}

function Roles() {
  const { data: me, can } = useMe();
  const { data: roles, error, isLoading, mutate } = useApi<Role[]>(can("roles.view") ? "/roles" : null);
  const [f, set] = useUrlState(["new", "view"] as const);
  const [edit, setEdit] = useState<Role | null>(null);
  const [del, setDel] = useState<Role | null>(null);
  const creating = f.new === "1";

  if (me && !can("roles.view")) return <Card><EmptyState icon="lock" title="You don't have access to roles" /></Card>;
  const groups = me?.permissionGroups ?? [];

  return (
    <div>
      <PageHeader title="Roles & permissions" description="A role sets task access (Admin, Leadership or Team member) plus admin permissions. Changes apply on the next page load."
        actions={can("roles.manage") && <Button variant="primary" icon="plus" onClick={() => set({ new: "1" })}>New role</Button>} />

      <div className="mb-4"><Segmented label="View" value={f.view || "cards"} onChange={(v) => set({ view: v === "cards" ? null : v })} options={[{ value: "cards", label: "Roles" }, { value: "matrix", label: "Permission matrix" }]} /></div>
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      {isLoading && !roles && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}</div>}

      {roles && (f.view !== "matrix" ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {roles.map((r, i) => (
            <Card key={r.id} as="article" className={cx("flex flex-col p-5 animate-fade-up", i > 5 && "[animation-delay:0ms]")}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className={cx("grid h-11 w-11 place-items-center rounded-xl", r.key === "owner" ? "bg-violet-50 text-violet-600" : r.isSystem ? "bg-brand-soft text-brand" : "bg-emerald-50 text-emerald-600")}><Icon name="shield" size={20} /></span>
                  <div><h2 className="font-bold text-slate-900">{r.name}</h2><p className="text-xs text-slate-500">{r.userCount} user{r.userCount === 1 ? "" : "s"} · {TIER_TEXT[r.tier]}</p></div>
                </div>
                {r.isSystem ? <Badge>Built-in</Badge> : <Badge tone="green">Custom</Badge>}
              </div>
              <p className="mt-3 flex-1 text-sm text-slate-600">{r.description || "No description."}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {groups.map((g) => {
                  const n = g.items.filter((it) => r.permissions.includes(it.key)).length;
                  return n ? <Badge key={g.group} tone="slate">{g.group}: {n}/{g.items.length}</Badge> : null;
                })}
              </div>
              <div className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4">
                <Button size="sm" icon={r.editable ? "edit" : "eye"} onClick={() => setEdit(r)}>{r.editable ? "Edit permissions" : "View permissions"}</Button>
                {r.deletable && <Button size="sm" variant="ghost" icon="trash" className="text-red-600 hover:bg-red-50" onClick={() => setDel(r)}>Delete</Button>}
              </div>
              {!r.editable && r.lockedReason && can("roles.manage") && <p className="mt-2 text-xs text-slate-500">{r.lockedReason}</p>}
            </Card>
          ))}
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b border-slate-100"><th scope="col" className="sticky left-0 bg-white px-5 py-4 text-left font-semibold text-slate-500">Permission</th>{roles.map((r) => <th key={r.id} scope="col" className="px-3 py-4 text-center font-bold">{r.name}</th>)}</tr></thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.group}>
                  <tr className="bg-slate-50/80"><th colSpan={roles.length + 1} scope="colgroup" className="px-5 py-2 text-left text-xs font-bold uppercase tracking-wide text-slate-500">{g.group}</th></tr>
                  {g.items.map((it) => (
                    <tr key={it.key} className="border-b border-slate-100">
                      <th scope="row" className="sticky left-0 bg-white px-5 py-3 text-left font-medium"><span className="block">{it.label}</span><span className="block text-xs font-normal text-slate-500">{it.description}</span></th>
                      {roles.map((r) => (
                        <td key={r.id} className="px-3 py-3 text-center">{r.permissions.includes(it.key) ? <Icon name="check" size={18} className="mx-auto text-emerald-600" label="Allowed" /> : <span className="text-slate-300" aria-label="Not allowed">—</span>}</td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      <RoleEditor open={creating || !!edit} role={edit} onClose={() => { setEdit(null); if (creating) set({ new: null }); }} />
      <DeleteRole role={del} roles={roles ?? []} onClose={() => setDel(null)} />
    </div>
  );
}

function RoleEditor({ open, role, onClose }: { open: boolean; role: Role | null; onClose: () => void }) {
  const { data: me } = useMe();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [tier, setTier] = useState("MEMBER");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? ""); setDescription(role?.description ?? ""); setPerms(new Set(role?.permissions ?? [])); setTier(role?.tier ?? "MEMBER"); setErrors({});
  }, [open, role?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const readOnly = !!role && !role.editable;
  const mine = new Set(me?.me.permissions ?? []);
  const isOwner = me?.me.roleKey === "owner";
  const grantable = (p: string) => isOwner || mine.has(p as never);
  const toggle = (p: string) => setPerms((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  async function save() {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = "Role name is required.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const body = { name, description, permissions: [...perms], tier };
      if (role) await api(`/roles/${role.id}`, { method: "PATCH", body });
      else await api("/roles", { body });
      await refreshAll();
      toast.success(role ? "Role updated" : "Role created", name.trim());
      onClose();
    } catch (err) {
      const a = err as ApiError;
      setErrors(a.fields ?? { form: a.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} busy={busy} size="lg" title={role ? (readOnly ? role.name : `Edit ${role.name}`) : "New role"}
      description={readOnly ? role?.lockedReason ?? "Read-only" : "Task access decides which tasks people see. The permissions below cover team and admin pages only."}
      footer={readOnly ? <Button variant="primary" onClick={onClose}>Close</Button> : <><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>{role ? "Save changes" : "Create role"}</Button></>}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Role name" required error={errors.name} hint={role?.isSystem ? "Built-in role names can't be changed." : undefined}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly || role?.isSystem} maxLength={40} />}</Field>
        <Field label="Description" optional>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} maxLength={200} />}</Field>
      </div>
      <Field label="Task access" error={errors.tier} hint={role?.isSystem ? "Built-in roles keep their task access." : "Admin and Leadership see every task and can drill into team statistics. Team members see their own tasks plus tasks shared with them."}>
        {(id) => <Select id={id} value={tier} onChange={(e) => setTier(e.target.value)} disabled={readOnly || role?.isSystem}><option value="MEMBER">Team member: own and shared tasks</option><option value="LEADERSHIP">Leadership: all tasks, approvals</option><option value="ADMIN">Admin: all tasks, admin controls</option></Select>}
      </Field>
      <p className="mb-2 text-sm font-bold text-slate-700">Account administration</p>
      {errors.permissions && <Alert>{errors.permissions}</Alert>}
      <div className="mt-2 space-y-4">
        {me?.permissionGroups.map((g) => {
          const keys = g.items.map((i) => i.key).filter(grantable);
          const all = keys.length > 0 && keys.every((k) => perms.has(k));
          return (
            <fieldset key={g.group} className="rounded-2xl border border-slate-200">
              <legend className="sr-only">{g.group}</legend>
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <p className="text-sm font-bold">{g.group}</p>
                {!readOnly && keys.length > 0 && <button type="button" className="text-xs font-semibold text-brand hover:underline" onClick={() => setPerms((s) => { const n = new Set(s); keys.forEach((k) => (all ? n.delete(k) : n.add(k))); return n; })}>{all ? "Clear all" : "Select all"}</button>}
              </div>
              <div className="divide-y divide-slate-100">
                {g.items.map((it) => {
                  const disabled = readOnly || !grantable(it.key);
                  return (
                    <label key={it.key} className={cx("flex items-start gap-3 px-4 py-3", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-slate-50")}>
                      <input type="checkbox" className="mt-0.5 h-5 w-5 rounded border-slate-300 accent-[#2563EB]" checked={perms.has(it.key)} disabled={disabled} onChange={() => toggle(it.key)} />
                      <span className="text-sm"><span className="block font-semibold text-slate-800">{it.label}</span><span className="block text-slate-500">{it.description}{!readOnly && !grantable(it.key) && " You don't have this permission, so you can't grant it."}</span></span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
      {errors.form && <Alert>{errors.form}</Alert>}
    </Modal>
  );
}

function DeleteRole({ role, roles, onClose }: { role: Role | null; roles: Role[]; onClose: () => void }) {
  const [target, setTarget] = useState("");
  useEffect(() => setTarget(roles.find((r) => r.key === "member")?.id ?? ""), [role?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!role) return null;
  return (
    <ConfirmDialog open title={`Delete ${role.name}?`} confirmLabel="Delete role" onClose={onClose}
      body={role.userCount ? <><b>{role.userCount} user{role.userCount > 1 ? "s" : ""}</b> have this role. Choose where to move them; pending invitations move too.</> : "This role isn't assigned to anyone. Deleting it can't be undone."}
      onConfirm={async () => { await api(`/roles/${role.id}`, { method: "DELETE", body: { reassignToRoleId: role.userCount ? target : null } }); await refreshAll(); toast.success("Role deleted", role.name); }}>
      {role.userCount > 0 && (
        <div className="mt-4"><Field label="Move users to">{(id) => <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>{roles.filter((r) => r.id !== role.id && r.key !== "owner").map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field></div>
      )}
    </ConfirmDialog>
  );
}
