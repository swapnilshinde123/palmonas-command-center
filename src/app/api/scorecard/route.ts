import { route } from "@/lib/api";
import { scorecard } from "@/domain/scorecard";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => scorecard(actor, query.month));
