import { route } from "@/lib/api";
import { softDelete } from "@/domain/deletion";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => softDelete(actor, params.id, body));
