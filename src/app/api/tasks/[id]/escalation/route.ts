import { route } from "@/lib/api";
import { triggerEscalation } from "@/domain/escalation";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => triggerEscalation(actor, params.id, body));
