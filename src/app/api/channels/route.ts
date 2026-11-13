import { route } from "@/lib/api";
import { channelSummary } from "@/domain/command";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => channelSummary(actor));
