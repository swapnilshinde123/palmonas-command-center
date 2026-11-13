import { route } from "@/lib/api";
import { escalationsView } from "@/domain/escalation";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => escalationsView(actor, query));
