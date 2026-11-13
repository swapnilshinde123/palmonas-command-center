import { route } from "@/lib/api";
import { decideWaiver } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => decideWaiver(actor, params.id, body));
