// Runs once per server process. Background jobs live in the web process so one Render service
// is enough; set RUN_WORKER=false when running a separate `npm run worker`.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.RUN_WORKER === "false") return;
  const { startInProcessWorker } = await import("./worker/jobs");
  startInProcessWorker();
}
