import { route } from "@/lib/api";
import { resolveEscalation } from "@/domain/escalation";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => resolveEscalation(actor, params.id, body));
