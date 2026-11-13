import { route } from "@/lib/api";
import { changeProjectStatus } from "@/domain/projects";

export const dynamic = "force-dynamic";
export const POST = route(({ actor, params, body }) => changeProjectStatus(actor, params.id, body));
