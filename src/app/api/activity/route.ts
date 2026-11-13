import { route } from "@/lib/api";
import { listActivity } from "@/domain/activity";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => listActivity(actor, query));
