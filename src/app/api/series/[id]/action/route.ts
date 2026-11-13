import { route } from "@/lib/api";
import { seriesAction } from "@/domain/recurrence";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => seriesAction(actor, params.id, body));
