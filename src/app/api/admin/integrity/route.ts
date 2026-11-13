import { route } from "@/lib/api";
import { integrityReport } from "@/domain/admin";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => integrityReport(actor));
