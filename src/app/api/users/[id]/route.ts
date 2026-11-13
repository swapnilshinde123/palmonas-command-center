import { route } from "@/lib/api";
import { updateUser, deleteUser } from "@/domain/users";

export const dynamic = "force-dynamic";
export const PATCH = route(({ actor, params, body }) => updateUser(actor, params.id, body));
export const DELETE = route(({ actor, params, body }) => deleteUser(actor, params.id, body));
