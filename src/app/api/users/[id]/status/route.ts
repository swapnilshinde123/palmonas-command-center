import { route } from "@/lib/api";
import { setUserStatus } from "@/domain/users";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => setUserStatus(actor, params.id, body));
