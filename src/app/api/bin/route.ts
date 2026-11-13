import { route } from "@/lib/api";
import { listBin } from "@/domain/deletion";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => listBin(actor));
