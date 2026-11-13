import { route } from "@/lib/api";
import { setFlag } from "@/domain/tasks";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => setFlag(actor, params.id, body));
