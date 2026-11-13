import { route } from "@/lib/api";
import { revokeAccess } from "@/domain/tasks";

export const dynamic = "force-dynamic";
export const DELETE = route(({ actor, params }) => revokeAccess(actor, params.id, params.accessId));
