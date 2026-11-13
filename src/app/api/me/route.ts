import { route } from "@/lib/api";
import { getProfile } from "@/domain/users";
import { assignableRoles } from "@/domain/roles";
import { PERMISSION_GROUPS } from "@/domain/permissions";
import { mailMode } from "@/domain/email";

export const dynamic = "force-dynamic";
export const GET = route(async ({ actor }) => ({ me: { ...(await getProfile(actor)), permissions: actor.permissions, roleKey: actor.roleKey }, assignableRoles: await assignableRoles(actor), permissionGroups: PERMISSION_GROUPS, mailMode: mailMode() }));
