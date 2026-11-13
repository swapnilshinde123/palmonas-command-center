import type { Tx } from "@/lib/db";
import { iso, todayBiz } from "@/lib/dates";

// Row-locking upsert serializes allocation per namespace/day (spec §36.3). If the surrounding
// transaction rolls back, the increment rolls back too, so an ID is never burned unless it was committed.
async function next(tx: Tx, namespace: string, day: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "IdCounter" ("namespace", "day", "value") VALUES (${namespace}, ${day}, 1)
    ON CONFLICT ("namespace", "day") DO UPDATE SET "value" = "IdCounter"."value" + 1
    RETURNING "value"`;
  return rows[0].value;
}

const pad = (n: number, w = 3) => String(n).padStart(w, "0");

export const TASK_ID_RE = /^[A-Z]{3}-\d{6}-\d{3,}$/;

export async function allocateTaskId(tx: Tx, namespaceCode: string, now = new Date()): Promise<string> {
  const ymd = iso(todayBiz(now))!.replace(/-/g, "").slice(2);
  const code = namespaceCode.toUpperCase();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `${code}-${ymd}-${pad(await next(tx, code, ymd))}`;
    // Guards against IDs that entered the table outside the allocator (e.g. imports).
    const clash = await tx.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM "Task" WHERE upper("id") = ${id} LIMIT 1`;
    if (clash.length === 0) return id;
  }
  throw new Error("Task ID allocation failed after 5 attempts");
}

export async function allocateSubtaskId(tx: Tx, taskId: string) {
  return `${taskId}-S${pad(await next(tx, `SUB:${taskId}`, ""), 2)}`;
}

export async function allocateSeriesId(tx: Tx, code: string, now = new Date()) {
  const ym = iso(todayBiz(now))!.replace(/-/g, "").slice(2, 6);
  return `SER-${code.toUpperCase()}-${ym}-${pad(await next(tx, `SER:${code}`, ym))}`;
}

export async function allocateProjectId(tx: Tx) {
  return `PRJ-${pad(await next(tx, "PRJ", ""), 4)}`;
}
