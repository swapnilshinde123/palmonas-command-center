import { route } from "@/lib/api";
import { updateRole, deleteRole } from "@/domain/roles";

export const dynamic = "force-dynamic";
export const PATCH = route(({ actor, params, body }) => updateRole(actor, params.id, body));
export const DELETE = route(({ actor, params, body }) => deleteRole(actor, params.id, body));
