import { route } from "@/lib/api";
import { requestTransfer } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => requestTransfer(actor, params.id, body));
