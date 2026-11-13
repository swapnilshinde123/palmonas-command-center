import { route } from "@/lib/api";
import { changeStatus } from "@/domain/tasks";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => changeStatus(actor, params.id, body));
