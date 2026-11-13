import { route } from "@/lib/api";
import { adminOverview } from "@/domain/admin";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => adminOverview(actor));
