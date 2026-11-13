import { route } from "@/lib/api";
import { listBell, markRead } from "@/domain/bell";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => listBell(actor, query));
export const POST = route(({ actor, body }) => markRead(actor, body));
