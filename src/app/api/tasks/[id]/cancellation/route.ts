import { route } from "@/lib/api";
import { requestCancellation } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => requestCancellation(actor, params.id, body));
