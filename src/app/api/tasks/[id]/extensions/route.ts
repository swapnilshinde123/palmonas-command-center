import { route } from "@/lib/api";
import { requestExtension } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => requestExtension(actor, params.id, body));
