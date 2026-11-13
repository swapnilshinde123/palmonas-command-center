"use client";
import { useEffect, useState } from "react";
import { api, ApiError, refreshAll } from "@/components/client";
import { useMe } from "@/components/me";
import { Avatar, Badge, Button, Card, CardHeader, Field, fmtDate, Input, PageHeader, PasswordInput, Skeleton } from "@/components/ui";
import { toast } from "@/components/toast";

export default function ProfilePage() {
  const { data } = useMe();
  const [p, setP] = useState({ name: "", title: "", phone: "" });
  const [pe, setPe] = useState<Record<string, string>>({});
  const [pBusy, setPBusy] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [we, setWe] = useState<Record<string, string>>({});
  const [wBusy, setWBusy] = useState(false);
  // Initialise once per saved version so background refreshes don't overwrite typing.
  useEffect(() => { if (data) setP({ name: data.me.name, title: data.me.title, phone: data.me.phone }); }, [data?.me.id, data?.me.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Skeleton className="h-96 rounded-2xl" />;
  const me = data.me;
  return (
    <div>
      <PageHeader title="My profile" description="Your personal details and password." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-6 text-center">
          <Avatar name={me.name} size={88} className="mx-auto" />
          <p className="mt-4 text-lg font-bold">{me.name}</p><p className="text-sm text-slate-500">{me.email}</p>
          <div className="mt-3"><Badge tone="blue">{me.role.name}</Badge></div>
          <dl className="mt-6 grid grid-cols-2 gap-3 text-left text-sm">
            <div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">Member since</dt><dd className="font-semibold">{fmtDate(me.createdAt)}</dd></div>
            <div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-500">Permissions</dt><dd className="font-semibold">{me.permissions.length}</dd></div>
          </dl>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Personal details" subtitle="Your email and role are managed by an admin." />
            <form className="grid gap-x-4 p-5 sm:grid-cols-2 sm:p-6" noValidate onSubmit={async (e) => {
              e.preventDefault();
              if (p.name.trim().length < 2) return setPe({ name: "Enter your full name." });
              setPBusy(true); setPe({});
              try { await api("/me/profile", { method: "PATCH", body: p }); await refreshAll(); toast.success("Profile saved"); }
              catch (err) { setPe((err as ApiError).fields ?? {}); toast.error("Couldn't save", (err as ApiError).message); }
              finally { setPBusy(false); }
            }}>
              <Field label="Full name" required error={pe.name} className="sm:col-span-2">{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />}</Field>
              <Field label="Job title" optional>{(id) => <Input id={id} value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} />}</Field>
              <Field label="Phone" optional error={pe.phone}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="tel" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />}</Field>
              <div className="sm:col-span-2"><Button variant="primary" type="submit" busy={pBusy}>Save details</Button></div>
            </form>
          </Card>
          <Card>
            <CardHeader title="Change password" subtitle="At least 8 characters with a letter and a number." />
            <form className="grid gap-x-4 p-5 sm:grid-cols-2 sm:p-6" noValidate onSubmit={async (e) => {
              e.preventDefault();
              const errs: Record<string, string> = {};
              if (!pw.current) errs.current = "Enter your current password.";
              if (pw.next.length < 8 || !/[A-Za-z]/.test(pw.next) || !/\d/.test(pw.next)) errs.next = "Use at least 8 characters with a letter and a number.";
              if (pw.next !== pw.confirm) errs.confirm = "Passwords don't match.";
              setWe(errs);
              if (Object.keys(errs).length) return;
              setWBusy(true);
              try { await api("/me/password", { body: { current: pw.current, next: pw.next } }); setPw({ current: "", next: "", confirm: "" }); toast.success("Password changed"); }
              catch (err) { setWe((err as ApiError).fields ?? { current: (err as ApiError).message }); }
              finally { setWBusy(false); }
            }}>
              <Field label="Current password" required error={we.current} className="sm:col-span-2">{(id, d, inv) => <PasswordInput id={id} aria-describedby={d} invalid={inv} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />}</Field>
              <Field label="New password" required error={we.next}>{(id, d, inv) => <PasswordInput id={id} aria-describedby={d} invalid={inv} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />}</Field>
              <Field label="Confirm new password" required error={we.confirm}>{(id, d, inv) => <PasswordInput id={id} aria-describedby={d} invalid={inv} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />}</Field>
              <div className="sm:col-span-2"><Button variant="primary" type="submit" busy={wBusy}>Update password</Button></div>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
