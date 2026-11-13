import { route } from "@/lib/api";
import { restore } from "@/domain/deletion";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => restore(actor, params.id, body));
