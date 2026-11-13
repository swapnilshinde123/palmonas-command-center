import { route } from "@/lib/api";
import { requestWaiver } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => requestWaiver(actor, params.id, body));
