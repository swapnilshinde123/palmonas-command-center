import type { Tx } from "./db";

export const LIVE_CHANNEL = "palmonas_live";

export type LiveSignal = { kind: "task"; taskId: string } | { kind: "bell"; userId: string } | { kind: "admin" };

// NOTIFY is transactional: listeners hear it only after the surrounding transaction commits.
// Payloads carry IDs only; clients refetch through the authorized API, so nothing leaks over the stream.
export async function liveSignal(tx: Tx, s: LiveSignal) {
  await tx.$executeRaw`SELECT pg_notify(${LIVE_CHANNEL}, ${JSON.stringify(s)})`;
}
