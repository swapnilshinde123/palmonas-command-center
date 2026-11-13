import { route } from "@/lib/api";
import { setStar } from "@/domain/tasks";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => setStar(actor, params.id, body));
