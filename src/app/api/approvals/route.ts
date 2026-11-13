import { route } from "@/lib/api";
import { approvalsInbox } from "@/domain/governance";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => approvalsInbox(actor));
