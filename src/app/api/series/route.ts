import { route } from "@/lib/api";
import { listSeries, createSeries } from "@/domain/recurrence";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => listSeries(actor));
export const POST = route(({ actor, body }) => createSeries(actor, body));
