import { z } from "zod";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import type { Invitation, Prisma } from "@prisma/client";
import { prisma, tx as runTx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { allocateUserCode, assertCan, can, type Actor } from "./actor";
import { logActivity } from "./activity";
import { canAssignRole } from "./roles";
import { appUrl, inviteEmail, sendEmail } from "./email";
import { BCRYPT_ROUNDS } from "./users";
import { EMAIL_RE, FieldErrors, normEmail, passwordProblem } from "./validation";

export const TTL_DAYS = Number(process.env.INVITE_TTL_DAYS ?? 7);
export const RESEND_COOLDOWN_SECONDS = Number(process.env.INVITE_RESEND_COOLDOWN_SECONDS ?? 60);
export const MAX_BATCH = 20;

export type EffectiveStatus = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";

// Expiry is derived from expiresAt, so there's no job to forget and no window where a stale link works.
export function effectiveStatus(i: Pick<Invitation, "status" | "expiresAt">, now = new Date()): EffectiveStatus {
  if (i.status === "PENDING" && i.expiresAt <= now) return "EXPIRED";
  return i.status;
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
};
const expiry = () => new Date(Date.now() + TTL_DAYS * 86_400_000);
export const inviteLink = (token: string) => `${appUrl()}/invite/${token}`;

async function deliver(inv: { id: string; email: string; expiresAt: Date; message: string }, token: string, inviterName: string, roleName: string) {
  const mail = inviteEmail({ inviter: inviterName, roleName, link: inviteLink(token), message: inv.message, expiresAt: inv.expiresAt });
  const r = await sendEmail({ to: inv.email, ...mail, kind: "invitation", relatedId: inv.id });
  await prisma.invitation.update({ where: { id: inv.id }, data: { lastEmailOk: r.ok } });
  return r;
}

const sendSchema = z.object({
  emails: z.union([z.array(z.string()), z.string()]).optional().default([]),
  roleId: z.string().optional().default(""),
  message: z.string().optional().default(""),
});

export async function sendInvitations(actor: Actor, body: unknown) {
  assertCan(actor, "invitations.send");
  const b = sendSchema.parse(body);
  const emails = [...new Set((Array.isArray(b.emails) ? b.emails : b.emails.split(/[\s,;]+/)).map(normEmail).filter(Boolean))];
  const fe = new FieldErrors();
  if (emails.length === 0) fe.add("emails", "Enter at least one email address.");
  if (emails.length > MAX_BATCH) fe.add("emails", `Invite at most ${MAX_BATCH} people at a time.`);
  const invalid = emails.filter((e) => !EMAIL_RE.test(e));
  if (invalid.length) fe.add("emails", `Not a valid email: ${invalid.join(", ")}`);
  const role = b.roleId ? await prisma.role.findUnique({ where: { id: b.roleId } }) : null;
  if (!b.roleId) fe.add("roleId", "Pick the role they'll get.");
  else if (!role) fe.add("roleId", "That role no longer exists.");
  else if (!canAssignRole(actor, role)) fe.add("roleId", "You can't invite people to a role with more access than your own.");
  if (b.message.length > 500) fe.add("message", "Keep the message under 500 characters.");
  fe.throwIfAny();

  const [existingUsers, pending] = await Promise.all([
    prisma.user.findMany({ where: { email: { in: emails, mode: "insensitive" } }, select: { email: true } }),
    prisma.invitation.findMany({ where: { email: { in: emails, mode: "insensitive" }, status: "PENDING" } }),
  ]);
  const taken = new Set(existingUsers.map((u) => u.email.toLowerCase()));
  const livePending = new Set(pending.filter((p) => effectiveStatus(p) === "PENDING").map((p) => p.email.toLowerCase()));
  const skipped: { email: string; reason: string }[] = [];
  const toSend = emails.filter((e) => {
    if (taken.has(e)) return skipped.push({ email: e, reason: "Already has an account" }), false;
    if (livePending.has(e)) return skipped.push({ email: e, reason: "Already invited. Use Resend instead" }), false;
    return true;
  });
  if (toSend.length === 0) throw fail.validation({ emails: skipped.map((s) => `${s.email}: ${s.reason}`).join(" · ") });

  const created = await runTx(async (tx) => {
    const out: { inv: Invitation; token: string }[] = [];
    for (const email of toSend) {
      // An expired pending invite for the same address is superseded rather than left dangling.
      await tx.invitation.updateMany({ where: { email: { equals: email, mode: "insensitive" }, status: "PENDING", expiresAt: { lte: new Date() } }, data: { status: "REVOKED", revokedAt: new Date(), revokedById: actor.id } });
      const { token, tokenHash } = newToken();
      const inv = await tx.invitation.create({ data: { email, roleId: role!.id, message: b.message.trim(), tokenHash, expiresAt: expiry(), invitedById: actor.id } });
      await logActivity(tx, { actor, action: "invitation.sent", targetType: "INVITATION", targetId: inv.id, targetLabel: email, meta: { role: role!.name } });
      out.push({ inv, token });
    }
    return out;
  });
  // Email goes out after commit; a failed send leaves a pending invite the admin can resend.
  const results = await Promise.all(created.map(async ({ inv, token }) => ({ email: inv.email, id: inv.id, ...(await deliver(inv, token, actor.name, role!.name)) })));
  return {
    sent: results.filter((r) => r.ok).map((r) => r.email),
    failed: results.filter((r) => !r.ok).map((r) => ({ email: r.email, id: r.id, error: (r as { error?: string }).error })),
    skipped,
    // Returned only to admins who can send; handy when SMTP isn't configured.
    links: process.env.SMTP_HOST ? undefined : Object.fromEntries(created.map(({ inv, token }) => [inv.email, inviteLink(token)])),
  };
}

export async function resendInvitation(actor: Actor, id: string) {
  assertCan(actor, "invitations.send");
  const { inv, token, roleName } = await runTx(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Invitation" WHERE "id" = ${id} FOR UPDATE`;
    const inv = await tx.invitation.findUnique({ where: { id }, include: { role: true } });
    if (!inv) throw fail.notFound("Invitation");
    const st = effectiveStatus(inv);
    if (st === "ACCEPTED") throw fail.conflict("This invitation was already accepted.");
    if (st === "REVOKED") throw fail.conflict("This invitation was revoked. Send a new one instead.");
    if (!canAssignRole(actor, inv.role)) throw fail.forbidden("You can't resend an invitation for a role with more access than your own.");
    const wait = RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - inv.lastSentAt.getTime()) / 1000);
    if (wait > 0) throw fail.conflict(`Just sent. You can resend in ${wait}s.`);
    if (await tx.user.findFirst({ where: { email: { equals: inv.email, mode: "insensitive" } } })) throw fail.conflict("This person already has an account.");
    // A fresh token invalidates the previous link; expiry restarts.
    const { token, tokenHash } = newToken();
    const updated = await tx.invitation.update({ where: { id }, data: { tokenHash, expiresAt: expiry(), sentCount: { increment: 1 }, lastSentAt: new Date() } });
    await logActivity(tx, { actor, action: "invitation.resent", targetType: "INVITATION", targetId: id, targetLabel: inv.email, meta: { sentCount: updated.sentCount, wasExpired: st === "EXPIRED" } });
    return { inv: updated, token, roleName: inv.role.name };
  });
  const r = await deliver(inv, token, actor.name, roleName);
  return { ok: r.ok, error: r.ok ? undefined : r.error, link: process.env.SMTP_HOST ? undefined : inviteLink(token) };
}

export async function revokeInvitation(actor: Actor, id: string) {
  assertCan(actor, "invitations.revoke");
  return runTx(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Invitation" WHERE "id" = ${id} FOR UPDATE`;
    const inv = await tx.invitation.findUnique({ where: { id } });
    if (!inv) throw fail.notFound("Invitation");
    if (inv.status !== "PENDING") throw fail.conflict(`This invitation is already ${inv.status.toLowerCase()}.`);
    await tx.invitation.update({ where: { id }, data: { status: "REVOKED", revokedAt: new Date(), revokedById: actor.id } });
    await logActivity(tx, { actor, action: "invitation.revoked", targetType: "INVITATION", targetId: id, targetLabel: inv.email });
    return { ok: true };
  });
}

export async function listInvitations(actor: Actor, raw: unknown) {
  assertCan(actor, "invitations.view");
  const f = z.object({ q: z.string().optional(), status: z.enum(["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"]).optional(), page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(5).max(100).optional() }).parse(raw ?? {});
  const now = new Date();
  const pageSize = f.pageSize ?? 10;
  const search: Prisma.InvitationWhereInput = f.q?.trim() ? { email: { contains: f.q.trim(), mode: "insensitive" } } : {};
  const byStatus: Record<EffectiveStatus, Prisma.InvitationWhereInput> = {
    PENDING: { status: "PENDING", expiresAt: { gt: now } },
    EXPIRED: { status: "PENDING", expiresAt: { lte: now } },
    ACCEPTED: { status: "ACCEPTED" },
    REVOKED: { status: "REVOKED" },
  };
  const where = { ...search, ...(f.status ? byStatus[f.status] : {}) };
  const [rows, total, ...counts] = await Promise.all([
    prisma.invitation.findMany({ where, include: { role: { select: { id: true, name: true } }, invitedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" }, skip: ((f.page ?? 1) - 1) * pageSize, take: pageSize }),
    prisma.invitation.count({ where }),
    ...(["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"] as const).map((s) => prisma.invitation.count({ where: { ...search, ...byStatus[s] } })),
  ]);
  return {
    rows: rows.map((i) => {
      const st = effectiveStatus(i, now);
      const wait = Math.max(0, RESEND_COOLDOWN_SECONDS - Math.floor((now.getTime() - i.lastSentAt.getTime()) / 1000));
      return {
        id: i.id, email: i.email, role: i.role, message: i.message, status: st, expiresAt: i.expiresAt, createdAt: i.createdAt, lastSentAt: i.lastSentAt,
        sentCount: i.sentCount, lastEmailOk: i.lastEmailOk, acceptedAt: i.acceptedAt, revokedAt: i.revokedAt, invitedBy: i.invitedBy?.name ?? "Deleted user",
        canResend: can(actor, "invitations.send") && (st === "PENDING" || st === "EXPIRED"), resendInSeconds: wait,
        canRevoke: can(actor, "invitations.revoke") && (st === "PENDING" || st === "EXPIRED"),
      };
    }),
    total, page: f.page ?? 1, pageSize,
    counts: { PENDING: counts[0], ACCEPTED: counts[1], EXPIRED: counts[2], REVOKED: counts[3], ALL: counts.reduce((a, b) => a + b, 0) },
    ttlDays: TTL_DAYS,
    resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
  };
}

// ---------- Public: accept flow ----------

export async function previewInvitation(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { state: "INVALID" as const };
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { role: true, invitedBy: { select: { name: true } } } });
  if (!inv) return { state: "INVALID" as const };
  const st = effectiveStatus(inv);
  return { state: st, email: inv.email, roleName: inv.role.name, inviter: inv.invitedBy?.name ?? "An admin", message: inv.message, expiresAt: inv.expiresAt };
}

export async function acceptInvitation(token: string, body: unknown) {
  const b = z.object({ name: z.string().optional().default(""), password: z.string().optional().default(""), confirm: z.string().optional().default("") }).parse(body);
  const fe = new FieldErrors();
  if (b.name.trim().length < 2) fe.add("name", "Enter your full name.");
  const pw = passwordProblem(b.password);
  if (pw) fe.add("password", pw);
  else if (b.password !== b.confirm) fe.add("confirm", "Passwords don't match.");
  fe.throwIfAny();
  const passwordHash = await bcrypt.hash(b.password, BCRYPT_ROUNDS);
  return runTx(async (tx) => {
    const found = await tx.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!found) throw fail.notFound("Invitation");
    await tx.$executeRaw`SELECT 1 FROM "Invitation" WHERE "id" = ${found.id} FOR UPDATE`;
    const inv = await tx.invitation.findUniqueOrThrow({ where: { id: found.id }, include: { role: true } });
    if (inv.tokenHash !== hashToken(token)) throw fail.conflict("This link was replaced by a newer invitation. Use the latest email.");
    const st = effectiveStatus(inv);
    if (st === "ACCEPTED") throw fail.conflict("This invitation was already used. Sign in instead.");
    if (st === "REVOKED") throw fail.conflict("This invitation was revoked. Ask an admin for a new one.");
    if (st === "EXPIRED") throw fail.conflict("This invitation has expired. Ask an admin to resend it.");
    if (await tx.user.findFirst({ where: { email: { equals: inv.email, mode: "insensitive" } } })) throw fail.conflict("An account with this email already exists. Sign in instead.");
    const code = await allocateUserCode(tx, b.name.trim());
    const user = await tx.user.create({ data: { email: inv.email, name: b.name.trim(), passwordHash, code, roleId: inv.roleId, status: "ACTIVE", createdById: inv.invitedById } });
    await tx.invitation.update({ where: { id: inv.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedUserId: user.id } });
    await logActivity(tx, { actor: { id: user.id, name: user.name }, action: "invitation.accepted", targetType: "INVITATION", targetId: inv.id, targetLabel: inv.email, meta: { role: inv.role.name } });
    return { email: user.email };
  });
}

// Google sign-in: a verified Google email that matches a live invitation creates the account
// (no password). Google proves the email; the invitation decides the role.
export async function acceptInvitationByVerifiedEmail(emailRaw: string, name: string) {
  const email = normEmail(emailRaw);
  return runTx(async (tx) => {
    const found = await tx.invitation.findFirst({ where: { email: { equals: email, mode: "insensitive" }, status: "PENDING" } });
    if (!found) return null;
    await tx.$executeRaw`SELECT 1 FROM "Invitation" WHERE "id" = ${found.id} FOR UPDATE`;
    const inv = await tx.invitation.findUniqueOrThrow({ where: { id: found.id }, include: { role: true } });
    if (effectiveStatus(inv) !== "PENDING") return null;
    const existing = await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
    if (existing) return existing;
    const display = name.trim().length >= 2 ? name.trim() : email.split("@")[0];
    const user = await tx.user.create({ data: { email: inv.email, name: display, code: await allocateUserCode(tx, display), roleId: inv.roleId, status: "ACTIVE", createdById: inv.invitedById } });
    await tx.invitation.update({ where: { id: inv.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedUserId: user.id } });
    await logActivity(tx, { actor: { id: user.id, name: user.name }, action: "invitation.accepted", targetType: "INVITATION", targetId: inv.id, targetLabel: inv.email, meta: { role: inv.role.name, via: "google" } });
    return user;
  });
}
