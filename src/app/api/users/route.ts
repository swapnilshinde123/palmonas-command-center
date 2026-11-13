import { route } from "@/lib/api";
import { listUsers, createUser } from "@/domain/users";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => listUsers(actor, query));
export const POST = route(({ actor, body }) => createUser(actor, body));
