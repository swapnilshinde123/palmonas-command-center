import { route } from "@/lib/api";
import { dueView } from "@/domain/command";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => dueView(actor, query));
