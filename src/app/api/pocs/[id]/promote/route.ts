import { route } from "@/lib/api";
import { requestPromotion } from "@/domain/poc";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => requestPromotion(actor, params.id, body));
