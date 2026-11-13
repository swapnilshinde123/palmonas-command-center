import { route } from "@/lib/api";
import { updateSubtask } from "@/domain/subtasks";

export const dynamic = "force-dynamic";
export const PATCH = route(({ actor, params, body }) => updateSubtask(actor, params.id, body));
