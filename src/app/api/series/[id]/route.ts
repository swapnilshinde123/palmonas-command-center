import { route } from "@/lib/api";
import { updateSeries } from "@/domain/recurrence";

export const dynamic = "force-dynamic";
export const PATCH = route(({ actor, params, body }) => updateSeries(actor, params.id, body));
