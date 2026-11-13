import { route } from "@/lib/api";
import { resendInvitation } from "@/domain/invitations";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params }) => resendInvitation(actor, params.id));
