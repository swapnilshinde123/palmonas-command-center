"use client";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, cx, Field, Input, PasswordInput } from "@/components/ui";

function strength(p: string) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Za-z]/.test(p) && /\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return s;
}

export function AcceptForm({ token, email, expiresAt }: { token: string; email: string; expiresAt: string }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = strength(f.password);

  return (
    <form noValidate onSubmit={async (e) => {
      e.preventDefault();
      const fe: Record<string, string> = {};
      if (f.name.trim().length < 2) fe.name = "Enter your full name.";
      if (f.password.length < 8 || !/[A-Za-z]/.test(f.password) || !/\d/.test(f.password)) fe.password = "Use at least 8 characters with a letter and a number.";
      else if (f.password !== f.confirm) fe.confirm = "Passwords don't match.";
      setErrors(fe);
      if (Object.keys(fe).length) return;
      setBusy(true); setError(null);
      const res = await fetch(`/api/public/invite/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) }).catch(() => null);
      const data = await res?.json().catch(() => null);
      if (!res?.ok) {
        setErrors(data?.error?.fields ?? {});
        setError(data?.error?.fields ? null : data?.error?.message ?? "Couldn't reach the server. Try again.");
        setBusy(false);
        return;
      }
      const r = await signIn("credentials", { email, password: f.password, redirect: false });
      if (r?.ok && !r.error) { router.replace("/"); router.refresh(); }
      else router.replace(`/login?joined=1&email=${encodeURIComponent(email)}`);
    }}>
      <Field label="Email">{(id) => <Input id={id} value={email} disabled readOnly />}</Field>
      <Field label="Full name" required error={errors.name}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />}</Field>
      <Field label="Create password" required error={errors.password} hint="At least 8 characters with a letter and a number.">
        {(id, d, inv) => <PasswordInput id={id} aria-describedby={d} invalid={inv} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}
      </Field>
      {f.password && (
        <div className="-mt-2 mb-4" aria-live="polite">
          <div className="flex gap-1">{[0, 1, 2, 3].map((i) => <span key={i} className={cx("h-1.5 flex-1 rounded-full", i < s ? (s <= 1 ? "bg-red-500" : s === 2 ? "bg-amber-500" : "bg-emerald-500") : "bg-slate-200")} />)}</div>
          <p className="mt-1 text-xs text-slate-500">Strength: {["Too weak", "Weak", "Fair", "Good", "Strong"][s]}</p>
        </div>
      )}
      <Field label="Confirm password" required error={errors.confirm}>{(id, d, inv) => <PasswordInput id={id} aria-describedby={d} invalid={inv} autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />}</Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="primary" busy={busy} className="mt-4 w-full">Create account & sign in</Button>
      <p className="mt-4 text-center text-xs text-slate-500">This invitation expires {new Date(expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.</p>
    </form>
  );
}
