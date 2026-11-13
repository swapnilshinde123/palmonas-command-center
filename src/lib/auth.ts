import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma, tx } from "./db";
import { DomainError } from "./errors";
import { loadActor, type Actor } from "@/domain/actor";
import { logActivity } from "@/domain/activity";
import { normEmail } from "@/domain/validation";
import { acceptInvitationByVerifiedEmail } from "@/domain/invitations";
import { log } from "./log";

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
// Password sign-in stays available for local use and as a fallback; set PASSWORD_LOGIN=false to make Google the only way in.
export const passwordLoginEnabled = () => process.env.PASSWORD_LOGIN !== "false" || !googleEnabled();

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = "$2b$12$BOh5quo9JsNpwJHgI2dU9.Gjej9/ribUohf3g8yHjWIXZdycxp4xa";

export async function verifyCredentials(emailRaw: string, password: string) {
  const email = normEmail(emailRaw);
  const u = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  const ok = await bcrypt.compare(password, u?.passwordHash ?? DUMMY_HASH);
  if (!u) return { ok: false as const, reason: "INVALID" };
  if (u.lockedUntil && u.lockedUntil > new Date()) return { ok: false as const, reason: "LOCKED" };
  if (!ok) {
    const fails = u.failedLoginCount + 1;
    const lock = fails >= MAX_FAILS;
    await tx(async (t) => {
      await t.user.update({ where: { id: u.id }, data: { failedLoginCount: lock ? 0 : fails, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : u.lockedUntil } });
      await logActivity(t, { actor: null, action: lock ? "auth.locked" : "auth.login_failed", targetType: "AUTH", targetId: u.id, targetLabel: u.email });
    });
    return { ok: false as const, reason: lock ? "LOCKED" : "INVALID" };
  }
  if (u.status !== "ACTIVE") return { ok: false as const, reason: u.status };
  await tx(async (t) => {
    await t.user.update({ where: { id: u.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await logActivity(t, { actor: { id: u.id, name: u.name }, action: "auth.login", targetType: "AUTH", targetId: u.id, targetLabel: u.email });
  });
  return { ok: true as const, user: u };
}

const providers: NextAuthOptions["providers"] = [];
if (googleEnabled())
  providers.push(GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET!, authorization: { params: { prompt: "select_account" } } }));
if (passwordLoginEnabled())
  providers.push(
    CredentialsProvider({
      id: "credentials",
      name: "Email",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(c) {
        const r = await verifyCredentials(String(c?.email ?? ""), String(c?.password ?? ""));
        // The error string is surfaced to the login page as ?error=<reason>.
        if (!r.ok) throw new Error(r.reason);
        return { id: r.user.id, email: r.user.email, name: r.user.name };
      },
    }),
  );

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/login", error: "/login" },
  providers,
  callbacks: {
    // Google: verified email only, optional domain allow-list, and the person must already have an
    // account or a live invitation. No self-signup.
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;
      const email = normEmail(user.email ?? "");
      const verified = (profile as { email_verified?: boolean } | undefined)?.email_verified === true;
      const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (!verified || (domains.length && !domains.some((d) => email.endsWith(`@${d}`)))) return "/login?error=GOOGLE_DOMAIN";
      let u = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
      if (!u) u = await acceptInvitationByVerifiedEmail(email, user.name ?? "");
      if (!u) {
        log.warn("google sign-in rejected: no account or invitation", { email });
        return "/login?error=NOT_INVITED";
      }
      if (u.status !== "ACTIVE") return `/login?error=${u.status}`;
      await tx(async (t) => {
        await t.user.update({ where: { id: u!.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
        await logActivity(t, { actor: { id: u!.id, name: u!.name }, action: "auth.google_login", targetType: "AUTH", targetId: u!.id, targetLabel: u!.email });
      });
      return true;
    },
    async jwt({ token, user, account }) {
      if (account?.provider === "google" && user?.email) {
        const u = await prisma.user.findFirst({ where: { email: { equals: user.email, mode: "insensitive" } } });
        token.uid = u?.id;
      } else if (user?.id) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      (session as unknown as { uid?: string }).uid = token.uid as string | undefined;
      return session;
    },
  },
};

export async function getActor(): Promise<Actor | null> {
  const session = await getServerSession(authOptions);
  const uid = (session as unknown as { uid?: string } | null)?.uid;
  return uid ? loadActor(uid) : null;
}

export async function requireActor(): Promise<Actor> {
  const a = await getActor();
  if (!a) throw new DomainError("UNAUTHENTICATED", "Your session ended. Sign in again.");
  return a;
}
