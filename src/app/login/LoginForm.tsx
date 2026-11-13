"use client";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, Button, Field, Input, PasswordInput } from "@/components/ui";

const MESSAGES: Record<string, string> = {
  INVALID: "That email and password don't match. Check them and try again.",
  LOCKED: "Too many failed attempts. Your account is locked for 15 minutes. Try again later or ask an admin to reactivate you.",
  SUSPENDED: "Your account is suspended. Contact an admin to restore access.",
  DEACTIVATED: "Your account has been deactivated. Contact an admin if you need access.",
  CredentialsSignin: "That email and password don't match.",
  NOT_INVITED: "That Google account isn't on the team yet. Ask an admin to invite this email address.",
  GOOGLE_DOMAIN: "Use your company Google account, with a verified email.",
  AccessDenied: "That Google account can't sign in here. Ask an admin to invite it.",
  OAuthSignin: "Google sign-in didn't start. Try again.",
  OAuthCallback: "Google sign-in didn't finish. Try again.",
};

function GoogleButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button type="button" className="w-full" busy={busy} onClick={() => { setBusy(true); signIn("google", { callbackUrl: "/" }); }}>
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      {label}
    </Button>
  );
}

export { GoogleButton };

function Form({ google, password: pwEnabled }: { google: boolean; password: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [email, setEmail] = useState(sp.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(sp.get("error") ? MESSAGES[sp.get("error")!] ?? MESSAGES.INVALID : null);
  const [busy, setBusy] = useState(false);
  const joined = sp.get("joined") === "1";

  if (!pwEnabled) return (
    <div>
      {error && <Alert>{error}</Alert>}
      <div className="mt-4"><GoogleButton label="Continue with Google" /></div>
      <p className="mt-6 text-center text-sm text-slate-500">New here? Ask an admin to invite your email address.</p>
    </div>
  );
  return (
    <form noValidate onSubmit={async (e) => {
      e.preventDefault();
      const fe: Record<string, string> = {};
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) fe.email = "Enter the email you were invited with.";
      if (!password) fe.password = "Enter your password.";
      setErrors(fe);
      if (Object.keys(fe).length) return;
      setBusy(true); setError(null);
      const r = await signIn("credentials", { email, password, redirect: false });
      if (r?.ok && !r.error) { router.replace("/"); router.refresh(); return; }
      setError(MESSAGES[r?.error ?? "INVALID"] ?? MESSAGES.INVALID);
      setBusy(false);
    }}>
      {joined && <Alert tone="success">Your account is ready. Sign in with your new password.</Alert>}
      {google && <div className="mt-2"><GoogleButton label="Continue with Google" /><div className="my-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-slate-400"><span className="h-px flex-1 bg-slate-200" />or use a password<span className="h-px flex-1 bg-slate-200" /></div></div>}
      <div className="mt-4">
        <Field label="Email" error={errors.email}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />}</Field>
        <Field label="Password" error={errors.password}>{(id, d, inv) => <PasswordInput id={id} aria-describedby={d} invalid={inv} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      </div>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="primary" busy={busy} className="mt-6 w-full">Sign in</Button>
      <p className="mt-6 text-center text-sm text-slate-500">New here? Ask an admin to send you an invitation.</p>
    </form>
  );
}

export function LoginForm(p: { google: boolean; password: boolean }) {
  return <Suspense><Form {...p} /></Suspense>;
}
