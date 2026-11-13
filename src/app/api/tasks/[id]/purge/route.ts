import { route } from "@/lib/api";
import { hardDelete } from "@/domain/deletion";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => hardDelete(actor, params.id, body));
