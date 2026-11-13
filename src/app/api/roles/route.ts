import { route } from "@/lib/api";
import { listRoles, createRole } from "@/domain/roles";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => listRoles(actor));
export const POST = route(({ actor, body }) => createRole(actor, body));
