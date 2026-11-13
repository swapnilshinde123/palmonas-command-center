import { route } from "@/lib/api";
import { decidePromotion } from "@/domain/poc";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => decidePromotion(actor, params.id, body));
