import { route } from "@/lib/api";
import { suggest } from "@/domain/poc";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => suggest(actor, query));
