import { route } from "@/lib/api";
import { listInvitations, sendInvitations } from "@/domain/invitations";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => listInvitations(actor, query));
export const POST = route(({ actor, body }) => sendInvitations(actor, body));
