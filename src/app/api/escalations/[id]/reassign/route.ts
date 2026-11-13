import { route } from "@/lib/api";
import { reassignEscalation } from "@/domain/escalation";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => reassignEscalation(actor, params.id, body));
