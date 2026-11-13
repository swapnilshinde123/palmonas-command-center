import type { NextRequest } from "next/server";
import { getActor } from "@/lib/auth";
import { loadActor } from "@/domain/actor";
import { canSeeTask } from "@/domain/task-core";
import { isPrivileged } from "@/domain/rbac";
import { prisma } from "@/lib/db";
import { liveBus } from "@/lib/live-listener";
import type { LiveSignal } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-sent events: tells each signed-in browser what changed so it refetches through the normal,
// authorized API. Members only hear about tasks they can see; other task changes arrive as an
// ID-less "stats" ping so dashboard counts refresh without revealing anything.
export async function GET(req: NextRequest) {
  const first = await getActor();
  if (!first) return new Response("Unauthorized", { status: 401 });
  const userId = first.id;
  const bus = liveBus();
  const enc = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const onSignal = async (s: LiveSignal) => {
        try {
          // Re-read the user every time so deactivation or a role change takes effect on the stream too.
          const actor = await loadActor(userId);
          if (!actor) return close();
          if (s.kind === "bell") { if (s.userId === userId) send("bell", {}); return; }
          if (s.kind === "admin") return send("admin", {});
          if (isPrivileged(actor) || (await canSeeTask(prisma, actor, s.taskId))) send("task", { taskId: s.taskId });
          else send("stats", {});
        } catch {
          /* a failed check never breaks the stream */
        }
      };
      const ping = setInterval(() => send("ping", { t: Date.now() }), 25_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        bus.off("signal", onSignal);
        try { controller.close(); } catch { /* already closed */ }
      };
      bus.on("signal", onSignal);
      req.signal.addEventListener("abort", close);
      send("ready", { retry: 3000 });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
