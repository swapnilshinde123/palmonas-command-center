import nodemailer, { type Transporter } from "nodemailer";
import { log } from "@/lib/log";

let transporter: Transporter | null = null;

export function mailMode(): "smtp" | "log" {
  return process.env.SMTP_HOST ? "smtp" : "log";
}

function getTransport(): Transporter {
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

export interface Mail { to: string; subject: string; html: string; text: string }

export type SendError = { category: "INVALID_RECIPIENT" | "AUTH" | "QUOTA" | "TEMPORARY" | "UNKNOWN"; permanent: boolean; message: string };

export function classify(err: unknown): SendError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const message = String(e?.message ?? err).slice(0, 500);
  const rc = e?.responseCode ?? 0;
  if (e?.code === "EENVELOPE" || rc === 550 || rc === 553 || rc === 501) return { category: "INVALID_RECIPIENT", permanent: true, message };
  if (e?.code === "EAUTH" || rc === 535) return { category: "AUTH", permanent: false, message };
  if (rc === 421 || rc === 452 || rc === 454 || /quota|rate/i.test(message)) return { category: "QUOTA", permanent: false, message };
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET"].includes(e?.code ?? "") || (rc >= 400 && rc < 500)) return { category: "TEMPORARY", permanent: false, message };
  return { category: "UNKNOWN", permanent: false, message };
}

export async function sendMail(m: Mail): Promise<string> {
  const info = await getTransport().sendMail({ from: process.env.SMTP_FROM ?? "Palmonas Ops <ops-noreply@localhost>", to: m.to, subject: m.subject, html: m.html, text: m.text });
  if (mailMode() === "log") log.info("email (log transport)", { to: m.to, subject: m.subject });
  return String(info.messageId ?? "");
}

export function resetTransportForTests(t: Transporter | null) {
  transporter = t;
}
