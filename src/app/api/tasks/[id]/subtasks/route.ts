import { route } from "@/lib/api";
import { createSubtask } from "@/domain/subtasks";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => createSubtask(actor, params.id, body));
