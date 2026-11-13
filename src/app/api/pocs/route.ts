import { route } from "@/lib/api";
import { listRegistry, upsertRegistryPoc } from "@/domain/poc";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => listRegistry(actor, query));
export const POST = route(({ actor, body }) => upsertRegistryPoc(actor, null, body));
