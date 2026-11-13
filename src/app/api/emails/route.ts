import { route } from "@/lib/api";
import { listEmails } from "@/domain/email";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => listEmails(actor, query));
