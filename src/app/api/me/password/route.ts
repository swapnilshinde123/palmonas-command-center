import { route } from "@/lib/api";
import { changePassword } from "@/domain/users";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, body }) => changePassword(actor, body));
