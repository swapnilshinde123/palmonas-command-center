import { route } from "@/lib/api";
import { pendingFromView } from "@/domain/poc";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => pendingFromView(actor, query));
