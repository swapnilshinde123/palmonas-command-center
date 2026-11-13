import { route } from "@/lib/api";
import { promotionQueue } from "@/domain/poc";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => promotionQueue(actor));
