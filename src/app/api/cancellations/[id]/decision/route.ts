import { route } from "@/lib/api";
import { decideCancellation } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => decideCancellation(actor, params.id, body));
