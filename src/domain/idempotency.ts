import { tx as runTx, type Tx } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { Actor } from "./rbac";

export interface Idempotent<T> {
  result: T;
  replayed: boolean;
}

// Spec §15.1/§36.4: a retried request with the same key returns the original result instead of
// performing the operation again. The advisory lock makes concurrent duplicates wait for the first.
export async function withIdempotency<T>(
  actor: Actor,
  key: string | null | undefined,
  operation: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<Idempotent<T>> {
  if (!key) return { result: await runTx(fn), replayed: false };
  if (key.length > 200) throw new Error("Idempotency key too long");
  return runTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.id + ":" + key}))`;
    const existing = await tx.idempotencyRecord.findUnique({ where: { actorId_key: { actorId: actor.id, key } } });
    if (existing) {
      if (existing.operation !== operation) throw new Error("Idempotency key reused for a different operation");
      return { result: existing.response as T, replayed: true };
    }
    const result = await fn(tx);
    await tx.idempotencyRecord.create({
      data: { actorId: actor.id, key, operation, response: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue },
    });
    return { result, replayed: false };
  });
}
