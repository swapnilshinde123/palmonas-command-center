import { route } from "@/lib/api";
import { projectRollups, createProject } from "@/domain/projects";

export const dynamic = "force-dynamic";
export const GET = route(({ actor }) => projectRollups(actor));
export const POST = route(({ actor, body }) => createProject(actor, body));
