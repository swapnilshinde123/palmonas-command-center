import { route } from "@/lib/api";
import { addCollaborator } from "@/domain/tasks";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => addCollaborator(actor, params.id, body));
