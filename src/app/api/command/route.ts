import { route } from "@/lib/api";
import { commandCenter } from "@/domain/command";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => commandCenter(actor));
