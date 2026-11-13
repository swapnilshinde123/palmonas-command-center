import nodemailer, { type Transporter } from "nodemailer";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { z } from "zod";
import { assertCan, type Actor } from "./actor";

let transporter: Transporter | null = null;
export const mailMode = (): "smtp" | "outbox" => (process.env.SMTP_HOST ? "smtp" : "outbox");

function transport() {
  if (transporter) return transporter;
  transporter = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

export function setTransportForTests(t: Transporter | null) {
  transporter = t;
}

export const appUrl = () => (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function inviteEmail(p: { inviter: string; roleName: string; link: string; message: string; expiresAt: Date }) {
  const exp = p.expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const subject = `${p.inviter} invited you to the Palmonas Command Center`;
  const html = `<!doctype html><html><body style="margin:0;background:#F3F4F6;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#0F172A">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#0F1B33;color:#fff;border-radius:16px 16px 0 0;padding:24px 28px;font-size:20px;font-weight:800">Palmonas · Ops Command</div>
<div style="background:#fff;border:1px solid #E2E8F0;border-top:0;border-radius:0 0 16px 16px;padding:28px">
<p style="font-size:16px;margin:0 0 12px"><b>${esc(p.inviter)}</b> invited you to join as <b>${esc(p.roleName)}</b>.</p>
${p.message ? `<blockquote style="margin:0 0 16px;padding:12px 16px;background:#F1F5F9;border-radius:10px;color:#334155">${esc(p.message)}</blockquote>` : ""}
<p style="font-size:14px;color:#334155;margin:0 0 8px">Sign in with Google using this email address, or set a password from the link.</p>
<p style="margin:24px 0"><a href="${esc(p.link)}" style="background:#2563EB;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">Accept invitation</a></p>
<p style="font-size:13px;color:#64748B;margin:0">This link expires on ${esc(exp)} and can be used once. If you weren't expecting this, you can ignore it.</p>
<p style="font-size:12px;color:#94A3B8;word-break:break-all;margin:16px 0 0">${esc(p.link)}</p>
</div></div></body></html>`;
  const text = `${p.inviter} invited you to the Palmonas Command Center as ${p.roleName}.\n${p.message ? `\n"${p.message}"\n` : ""}\nAccept: ${p.link}\nExpires ${exp}.`;
  return { subject, html, text };
}

// Never throws: the caller records whether delivery worked so the admin can resend.
export async function sendEmail(m: { to: string; subject: string; html: string; text: string; kind: string; relatedId?: string }) {
  try {
    await transport().sendMail({ from: process.env.SMTP_FROM ?? "Palmonas Ops <no-reply@localhost>", to: m.to, subject: m.subject, html: m.html, text: m.text });
    await prisma.emailLog.create({ data: { ...m, status: mailMode() === "smtp" ? "SENT" : "LOGGED" } });
    return { ok: true as const };
  } catch (err) {
    const error = String((err as Error)?.message ?? err).slice(0, 500);
    log.error("email send failed", { to: m.to, kind: m.kind, error });
    await prisma.emailLog.create({ data: { ...m, status: "FAILED", error } }).catch(() => undefined);
    return { ok: false as const, error };
  }
}

export async function listEmails(actor: Actor, raw: unknown) {
  assertCan(actor, "emails.view");
  const f = z.object({ page: z.coerce.number().int().min(1).optional() }).parse(raw ?? {});
  const take = 20;
  const [rows, total] = await Promise.all([
    prisma.emailLog.findMany({ orderBy: { createdAt: "desc" }, skip: ((f.page ?? 1) - 1) * take, take }),
    prisma.emailLog.count(),
  ]);
  return { rows, total, page: f.page ?? 1, pageSize: take, mode: mailMode() };
}
