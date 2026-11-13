import { route } from "@/lib/api";
import { adjustScore } from "@/domain/scorecard";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, body }) => adjustScore(actor, body));
