import { route } from "@/lib/api";
import { respondEscalation } from "@/domain/escalation";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => respondEscalation(actor, params.id, body));
