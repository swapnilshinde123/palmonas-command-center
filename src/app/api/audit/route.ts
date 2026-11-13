import { route } from "@/lib/api";
import { auditLog } from "@/domain/admin";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => auditLog(actor, query));
