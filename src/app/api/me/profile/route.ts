import { route } from "@/lib/api";
import { updateProfile } from "@/domain/users";

export const dynamic = "force-dynamic";
export const PATCH = route(({ actor, body }) => updateProfile(actor, body));
