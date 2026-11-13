import { route } from "@/lib/api";
import { setConfig } from "@/domain/admin";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, body }) => setConfig(actor, body));
