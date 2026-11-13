import { route } from "@/lib/api";
import { upsertMilestone } from "@/domain/projects";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => { const b = body as { id?: string }; return upsertMilestone(actor, params.id, b?.id ?? null, body); });
