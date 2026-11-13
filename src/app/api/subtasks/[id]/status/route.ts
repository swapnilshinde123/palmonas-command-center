import { route } from "@/lib/api";
import { changeSubtaskStatus } from "@/domain/subtasks";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => changeSubtaskStatus(actor, params.id, body));
