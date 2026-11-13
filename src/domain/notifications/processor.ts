import type { NotificationEvent } from "@prisma/client";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { getConfig } from "@/lib/config";
import { classify, sendMail } from "./mailer";
import { render } from "./templates";

// Atomic claim with SKIP LOCKED: overlapping processors never pick the same event (§39.7).
// Expired PROCESSING claims (crashed worker) are reclaimable after claimTimeoutMinutes.
async function claim(batch: number, claimTimeoutMinutes: number): Promise<NotificationEvent[]> {
  return prisma.$queryRaw<NotificationEvent[]>`
    UPDATE "NotificationEvent" SET "status" = 'PROCESSING', "claimedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "NotificationEvent"
      WHERE ("status" IN ('PENDING','FAILED') AND "nextAttemptAt" <= now())
         OR ("status" = 'PROCESSING' AND "claimedAt" < now() - make_interval(mins => ${claimTimeoutMinutes}::int))
      ORDER BY "createdAt" LIMIT ${batch}::int FOR UPDATE SKIP LOCKED)
    RETURNING *`;
}

export async function processQueue(batch = 50) {
  const cfg = await getConfig("notifications");
  const events = await claim(batch, cfg.claimTimeoutMinutes);
  const summary = { claimed: events.length, sent: 0, failed: 0, dead: 0, skipped: 0 };

  for (const ev of events) {
    // Per-event error boundary: one bad event never aborts the batch (§39.6).
    try {
      const recipient = await prisma.user.findUnique({ where: { id: ev.recipientId } });
      if (recipient?.status !== "ACTIVE" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient.email)) {
        await prisma.notificationEvent.update({ where: { id: ev.id }, data: { status: "DEAD", errorCategory: "INVALID_RECIPIENT", error: "Recipient inactive or has no valid email", lastAttemptAt: new Date(), attempts: { increment: 1 } } });
        summary.dead++;
        continue;
      }
      if (ev.taskId && !["MORNING_DIGEST_PERSONAL", "EXECUTIVE_DIGEST"].includes(ev.eventType)) {
        const t = await prisma.task.findUnique({ where: { id: ev.taskId }, select: { softDeleted: true } });
        if (!t || t.softDeleted) {
          await prisma.notificationEvent.update({ where: { id: ev.id }, data: { status: "SKIPPED", errorCategory: "MISSING_TASK", error: "Task missing or in bin", lastAttemptAt: new Date() } });
          summary.skipped++;
          continue;
        }
      }
      let mail;
      try {
        mail = render(ev.eventType, ev.subject, ev.payload as Record<string, unknown>);
      } catch (e) {
        await prisma.notificationEvent.update({ where: { id: ev.id }, data: { status: "DEAD", errorCategory: "MALFORMED_PAYLOAD", error: String(e).slice(0, 500), lastAttemptAt: new Date(), attempts: { increment: 1 } } });
        summary.dead++;
        continue;
      }
      await sendMail({ to: recipient.email, subject: ev.subject, ...mail });
      await prisma.notificationEvent.update({ where: { id: ev.id }, data: { status: "SENT", sentAt: new Date(), lastAttemptAt: new Date(), attempts: { increment: 1 }, error: null, errorCategory: null } });
      summary.sent++;
    } catch (err) {
      const c = classify(err);
      const attempts = ev.attempts + 1;
      const dead = c.permanent || attempts >= cfg.maxAttempts;
      const backoff = cfg.backoffMinutes[Math.min(attempts - 1, cfg.backoffMinutes.length - 1)] ?? 60;
      await prisma.notificationEvent.update({
        where: { id: ev.id },
        data: { status: dead ? "DEAD" : "FAILED", attempts, lastAttemptAt: new Date(), error: c.message, errorCategory: c.category, nextAttemptAt: new Date(Date.now() + backoff * 60_000) },
      });
      if (dead) summary.dead++; else summary.failed++;
      log.warn("notification delivery failed", { id: ev.id, eventType: ev.eventType, category: c.category, attempts, dead });
    }
  }
  if (summary.claimed) log.info("notification batch", summary);
  return summary;
}

export async function retryDead(ids: string[]) {
  return prisma.notificationEvent.updateMany({ where: { id: { in: ids }, status: { in: ["DEAD", "FAILED"] } }, data: { status: "PENDING", nextAttemptAt: new Date(), attempts: 0 } });
}
