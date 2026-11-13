import { route } from "@/lib/api";
import { cancelTransfer } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params }) => cancelTransfer(actor, params.id));
