import { route } from "@/lib/api";
import { meta } from "@/domain/admin";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => meta(actor));
