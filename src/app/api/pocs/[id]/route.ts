import { route } from "@/lib/api";
import { upsertRegistryPoc } from "@/domain/poc";

export const dynamic = "force-dynamic";
export const PATCH = route(({ actor, params, body }) => upsertRegistryPoc(actor, params.id, body));
