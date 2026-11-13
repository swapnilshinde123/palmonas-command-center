import { publicRoute } from "@/lib/api";
import { acceptInvitation, previewInvitation } from "@/domain/invitations";

export const dynamic = "force-dynamic";
export const GET = publicRoute(({ params }) => previewInvitation(params.token));
export const POST = publicRoute(({ params, body }) => acceptInvitation(params.token, body));
