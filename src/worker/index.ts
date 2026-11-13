import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { tick } from "./jobs";

// Standalone worker (optional). The web process already runs these jobs unless RUN_WORKER=false.
let stopping = false;

async function main() {
  log.info("worker started");
  const shutdown = async () => {
    stopping = true;
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  while (!stopping) {
    await tick(() => stopping);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

main().catch((err) => {
  log.error("worker crashed", { err: String(err) });
  process.exit(1);
});
