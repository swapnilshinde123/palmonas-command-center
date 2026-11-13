import { route } from "@/lib/api";
import { upsertList } from "@/domain/admin";
import { fail } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => { if (params.kind !== "channel" && params.kind !== "workstream") throw fail.notFound("List"); const b = body as { id?: string }; return upsertList(actor, params.kind, b?.id ?? null, body); });
