import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { runTimeDriven } from "@/domain/recurrence";
import { generateDigests } from "@/domain/notifications/digests";
import { processQueue } from "@/domain/notifications/processor";

// Every job is safe under overlap (row locks, SKIP LOCKED claims, unique dedup keys), so two
// processes during a deploy cannot double-spawn or double-send. Escalations have no timer job:
// levels change only when a person reassigns them (brief §7).
const JOBS: { name: string; everySeconds: number; run: () => Promise<unknown> }[] = [
  { name: "recurrence-spawn", everySeconds: 300, run: () => runTimeDriven() },
  { name: "digests", everySeconds: 60, run: () => generateDigests() },
  { name: "notification-queue", everySeconds: Number(process.env.QUEUE_POLL_SECONDS ?? 60), run: () => processQueue() },
];

const lastRun = new Map<string, number>();

export async function tick(stopping: () => boolean = () => false) {
  for (const job of JOBS) {
    if (stopping()) return;
    if (Date.now() - (lastRun.get(job.name) ?? 0) < job.everySeconds * 1000) continue;
    lastRun.set(job.name, Date.now());
    const started = Date.now();
    const name = `job:${job.name}`;
    try {
      const detail = { ok: true, ms: 0, result: (await job.run()) ?? null } as Record<string, unknown>;
      detail.ms = Date.now() - started;
      await prisma.workerHeartbeat.upsert({ where: { name }, create: { name, lastRunAt: new Date(), detail: detail as object }, update: { lastRunAt: new Date(), detail: detail as object } });
    } catch (err) {
      log.error("job failed", { job: job.name, err: String(err) });
      const detail = { ok: false, error: String(err).slice(0, 500) };
      await prisma.workerHeartbeat.upsert({ where: { name }, create: { name, lastRunAt: new Date(), detail }, update: { lastRunAt: new Date(), detail } }).catch(() => undefined);
    }
  }
}

let started = false;
export function startInProcessWorker() {
  if (started) return;
  started = true;
  log.info("in-process worker started", { jobs: JOBS.map((j) => j.name) });
  const loop = async () => {
    await tick().catch((err) => log.error("worker tick failed", { err: String(err) }));
    setTimeout(loop, 15_000);
  };
  setTimeout(loop, 5_000);
}
