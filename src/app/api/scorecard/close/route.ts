import { route } from "@/lib/api";
import { closePeriod } from "@/domain/scorecard";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, body }) => closePeriod(actor, String((body as { month?: string })?.month ?? "")));
