import { route } from "@/lib/api";
import { revokeInvitation } from "@/domain/invitations";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params }) => revokeInvitation(actor, params.id));
