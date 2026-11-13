import { route } from "@/lib/api";
import { setHoliday } from "@/domain/admin";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, body }) => setHoliday(actor, body));
