import { route } from "@/lib/api";
import { getTaskDetail, updateTask } from "@/domain/tasks";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, params }) => getTaskDetail(actor, params.id));
export const PATCH = route(({ actor, params, body }) => updateTask(actor, params.id, body));
