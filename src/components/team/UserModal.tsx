"use client";
import { useEffect, useState } from "react";
import { api, ApiError, refreshAll } from "../client";
import { Alert, Button, Field, Input, Modal, PasswordInput, Select } from "../ui";
import { useMe } from "../me";
import { toast } from "../toast";

export interface UserRow {
  id: string; name: string; email: string; title: string; phone: string; status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED"; version: number;
  role: { id: string; key: string; name: string; tier: string }; code: string; escalationLevel: "L1" | "L2" | "L3" | null; lastLoginAt: string | null; createdAt: string;
  isSelf: boolean; canEdit: boolean; canChangeStatus: boolean; canDelete: boolean;
}

const EMPTY = { name: "", email: "", title: "", phone: "", roleId: "", password: "", status: "ACTIVE", code: "", escalationLevel: "" };

export function UserModal({ open, onClose, user }: { open: boolean; onClose: () => void; user?: UserRow | null }) {
  const { data } = useMe();
  const editing = !!user;
  const [f, setF] = useState(EMPTY);
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset only when opened for a (different) user; list/me revalidation must not wipe in-progress edits.
  useEffect(() => {
    if (!open) return;
    setErrors({}); setFormError(null);
    if (user) { setF({ name: user.name, email: user.email, title: user.title, phone: user.phone, roleId: user.role.id, password: "", status: user.status, code: user.code, escalationLevel: user.escalationLevel ?? "" }); setVersion(user.version); }
    else setF(EMPTY);
  }, [open, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && !user && !f.roleId && data) setF((x) => ({ ...x, roleId: data.assignableRoles.find((r) => r.key === "member")?.id ?? "" }));
  }, [open, user, f.roleId, data]);

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => { setF((x) => ({ ...x, [k]: e.target.value })); setErrors((x) => ({ ...x, [k]: "" })); };

  // The current role must stay selectable even if the editor couldn't assign it themselves.
  const roles = [...(data?.assignableRoles ?? [])];
  if (user && !roles.some((r) => r.id === user.role.id)) roles.unshift({ ...user.role, description: "" });
  const isAdmin = data?.me.role.tier === "ADMIN";
  const roleLocked = !!user && (user.isSelf || !data?.assignableRoles.some((r) => r.id === user.role.id));

  function validate() {
    const e: Record<string, string> = {};
    if (f.name.trim().length < 2) e.name = "Enter the person's full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) e.email = "Enter a valid email address, like name@company.com.";
    if (f.phone.trim() && !/^[+()\d\s-]{6,20}$/.test(f.phone.trim())) e.phone = "Use digits, spaces, +, - or brackets.";
    if (!f.roleId) e.roleId = "Pick a role.";
    if (f.code && !/^[A-Za-z]{3}$/.test(f.code)) e.code = "Use exactly 3 letters.";
    if (!editing && f.password) {
      if (f.password.length < 8) e.password = "Use at least 8 characters.";
      else if (!/[A-Za-z]/.test(f.password) || !/\d/.test(f.password)) e.password = "Include at least one letter and one number.";
    }
    return e;
  }

  async function submit() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFormError(null);
    try {
      if (editing) {
        await api(`/users/${user!.id}`, { method: "PATCH", body: { expectedVersion: version, name: f.name, email: f.email, title: f.title, phone: f.phone, roleId: f.roleId, ...(isAdmin ? { escalationLevel: f.escalationLevel || null } : {}) } });
        toast.success("User updated", f.name);
      } else {
        await api("/users", { body: { ...f, code: f.code || null, password: f.password || undefined, escalationLevel: isAdmin ? f.escalationLevel || null : undefined } });
        toast.success("Team member added", f.password ? `${f.name} can sign in with the password you set.` : `${f.name} can sign in with Google using ${f.email}.`);
      }
      await refreshAll();
      onClose();
    } catch (err) {
      const a = err as ApiError;
      if (a.code === "STALE") {
        const latest = a.details as { version: number } | undefined;
        if (latest) setVersion(latest.version);
        setFormError("Someone else updated this user while you were editing. Your changes are kept; review and save again.");
      } else {
        if (a.fields) setErrors(a.fields);
        setFormError(a.fields ? null : a.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} busy={busy} title={editing ? "Edit user" : "Add user"} description={editing ? user!.email : "Create an account directly. To let someone choose their own password, send an invitation instead."}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>{editing ? "Save changes" : "Add user"}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors.name} className="sm:col-span-2">{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} value={f.name} onChange={set("name")} autoComplete="off" />}</Field>
          <Field label="Email" required error={errors.email} className="sm:col-span-2">{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="email" value={f.email} onChange={set("email")} autoComplete="off" />}</Field>
          <Field label="Job title" optional error={errors.title}>{(id) => <Input id={id} value={f.title} onChange={set("title")} placeholder="e.g. Marketplace manager" />}</Field>
          <Field label="Phone" optional error={errors.phone}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="tel" value={f.phone} onChange={set("phone")} placeholder="+91 98765 43210" />}</Field>
          <Field label="Role" required error={errors.roleId} className="sm:col-span-2"
            hint={roleLocked ? (user?.isSelf ? "You can't change your own role." : "You can't change this user's role.") : roles.find((r) => r.id === f.roleId)?.description}>
            {(id, d, inv) => (
              <Select id={id} aria-describedby={d} invalid={inv} value={f.roleId} onChange={set("roleId")} disabled={roleLocked}>
                <option value="">Select a role</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Task ID code" optional={!editing} error={errors.code} hint={editing ? "Used in task IDs; can't change once set." : "3 letters used in task IDs, e.g. HSH. Left blank, it's made from the name."}>
            {(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} value={f.code} onChange={set("code")} maxLength={3} disabled={editing} className="uppercase" />}
          </Field>
          <Field label="Escalation level" optional error={errors.escalationLevel} hint={isAdmin ? "L1, L2 and L3 owners handle escalations. One person per level." : "Only an Admin can set this."}>
            {(id, d, inv) => <Select id={id} aria-describedby={d} invalid={inv} value={f.escalationLevel} onChange={set("escalationLevel")} disabled={!isAdmin}><option value="">None (L0)</option><option value="L1">L1</option><option value="L2">L2</option><option value="L3">L3</option></Select>}
          </Field>
          {!editing && (
            <>
              <Field label="Temporary password" optional error={errors.password} hint="Leave blank if they'll sign in with Google. Otherwise at least 8 characters with a letter and a number." className="sm:col-span-2">
                {(id, d, inv) => <PasswordInput id={id} aria-describedby={d} invalid={inv} value={f.password} onChange={set("password")} autoComplete="new-password" />}
              </Field>
              <Field label="Status" className="sm:col-span-2">{(id) => <Select id={id} value={f.status} onChange={set("status")}><option value="ACTIVE">Active: can sign in now</option><option value="SUSPENDED">Suspended: created but can't sign in yet</option></Select>}</Field>
            </>
          )}
        </div>
        {formError && <Alert tone={formError.startsWith("Someone") ? "warning" : "error"}>{formError}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
