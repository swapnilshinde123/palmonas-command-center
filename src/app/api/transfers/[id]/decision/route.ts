import { route } from "@/lib/api";
import { decideTransfer } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => decideTransfer(actor, params.id, body));
