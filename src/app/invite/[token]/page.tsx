import Link from "next/link";
import { previewInvitation } from "@/domain/invitations";
import { AuthLayout } from "@/components/AuthLayout";
import { AcceptForm } from "./AcceptForm";
import { googleEnabled, passwordLoginEnabled } from "@/lib/auth";
import { GoogleButton } from "@/app/login/LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation", robots: { index: false } };

const DEAD: Record<string, { title: string; body: string }> = {
  INVALID: { title: "This link isn't valid", body: "It may have been replaced by a newer invitation. Use the most recent email, or ask the person who invited you to resend it." },
  EXPIRED: { title: "This invitation has expired", body: "Invitation links expire for security. Ask the person who invited you to resend it; you'll get a fresh link." },
  REVOKED: { title: "This invitation was cancelled", body: "An admin revoked it. Contact them if you still need access." },
  ACCEPTED: { title: "You've already joined", body: "This invitation was used to create an account. Sign in to continue." },
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await previewInvitation(token);
  if (p.state !== "PENDING") {
    const d = DEAD[p.state];
    return (
      <AuthLayout title={d.title} subtitle={d.body}>
        <Link href={p.state === "ACCEPTED" && "email" in p ? `/login?email=${encodeURIComponent(p.email!)}` : "/login"} className="inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-hover">Go to sign in</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Join the team" subtitle={<><b className="text-slate-800">{p.inviter}</b> invited <b className="text-slate-800">{p.email}</b> to join as <b className="text-slate-800">{p.roleName}</b>.</>}>
      {p.message && <blockquote className="mb-6 rounded-2xl bg-slate-100 p-4 text-sm text-slate-700">“{p.message}”</blockquote>}
      {googleEnabled() && (
        <div className="mb-6">
          <GoogleButton label={`Join with Google as ${p.email}`} />
          <p className="mt-2 text-xs text-slate-500">Sign in with the Google account for {p.email}. Any other account is turned away.</p>
        </div>
      )}
      {passwordLoginEnabled() && <AcceptForm token={token} email={p.email!} expiresAt={p.expiresAt!.toISOString()} />}
    </AuthLayout>
  );
}
