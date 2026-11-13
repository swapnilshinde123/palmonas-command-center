import { route } from "@/lib/api";
import { decideExtension } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => decideExtension(actor, params.id, body));
