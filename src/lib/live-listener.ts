import { EventEmitter } from "node:events";
import { Client } from "pg";
import { log } from "./log";
import { LIVE_CHANNEL, type LiveSignal } from "./live";

// One LISTEN connection per server process, fanned out to every open SSE stream.
// LISTEN needs a direct (unpooled) connection, so DIRECT_URL is preferred on Neon.
const g = globalThis as unknown as { liveHub?: { bus: EventEmitter; started: boolean } };
const hub = (g.liveHub ??= { bus: new EventEmitter(), started: false });
hub.bus.setMaxListeners(1000);

async function connect(attempt = 0): Promise<void> {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query(`LISTEN ${LIVE_CHANNEL}`);
    log.info("live listener connected");
    client.on("notification", (m) => {
      try {
        hub.bus.emit("signal", JSON.parse(m.payload ?? "{}") as LiveSignal);
      } catch {
        /* malformed payloads are ignored */
      }
    });
    client.on("error", (err) => {
      log.warn("live listener dropped", { err: String(err) });
      client.end().catch(() => undefined);
      setTimeout(() => connect(0), 2000);
    });
  } catch (err) {
    const wait = Math.min(30_000, 1000 * 2 ** attempt);
    log.warn("live listener connect failed", { err: String(err), retryMs: wait });
    client.end().catch(() => undefined);
    setTimeout(() => connect(attempt + 1), wait);
  }
}

export function liveBus() {
  if (!hub.started) {
    hub.started = true;
    void connect();
  }
  return hub.bus;
}
