import { route } from "@/lib/api";
import { projectDetail, updateProject } from "@/domain/projects";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, params }) => projectDetail(actor, params.id));
export const PATCH = route(({ actor, params, body }) => updateProject(actor, params.id, body));
