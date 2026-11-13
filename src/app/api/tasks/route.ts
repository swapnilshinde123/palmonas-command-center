import { route } from "@/lib/api";
import { listTasks, createTask } from "@/domain/tasks";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => listTasks(actor, query));
export const POST = route(({ actor, body, req }) => createTask(actor, body as never, req.headers.get("idempotency-key")));
