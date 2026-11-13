import { z } from "zod";
import { prisma, tx as runTx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { assertCan, isOwner, type Actor } from "./actor";
import { logActivity } from "./activity";
import { ALL_PERMISSIONS, isPermission, TIER_RANK, type Permission, type Tier } from "./permissions";
import { FieldErrors } from "./validation";

export async function listRoles(actor: Actor) {
  assertCan(actor, "roles.view");
  const roles = await prisma.role.findMany({ include: { _count: { select: { users: true } } }, orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }] });
  return roles.map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: r.isSystem, tier: r.tier, userCount: r._count.users,
    editable: canEditRole(actor, r).ok, deletable: !r.isSystem && actor.permissions.includes("roles.manage"),
    lockedReason: canEditRole(actor, r).reason,
  }));
}

// Roles the actor may hand out: never one with permissions the actor lacks (no privilege escalation).
export async function assignableRoles(actor: Actor) {
  const roles = await prisma.role.findMany({ orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }] });
  return roles.filter((r) => canAssignRole(actor, r)).map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, tier: r.tier }));
}

export function canAssignRole(actor: Actor, role: { key: string; permissions: string[]; tier: Tier }) {
  if (isOwner(actor)) return true;
  if (role.key === "owner") return false;
  // Task-workspace access counts too: nobody can hand out a tier above their own.
  if (TIER_RANK[role.tier] > TIER_RANK[actor.role]) return false;
  return role.permissions.every((p) => actor.permissions.includes(p as Permission));
}

function canEditRole(actor: Actor, role: { id: string; key: string }) {
  if (!actor.permissions.includes("roles.manage")) return { ok: false, reason: "You can view roles but not change them." };
  if (role.key === "owner") return { ok: false, reason: "The Owner role always has every permission." };
  if (role.id === actor.roleId) return { ok: false, reason: "You can't edit your own role. Ask another admin." };
  return { ok: true, reason: null as string | null };
}

const roleSchema = z.object({
  name: z.string().optional().default(""),
  description: z.string().optional().default(""),
  permissions: z.array(z.string()).optional().default([]),
  tier: z.enum(["ADMIN", "LEADERSHIP", "MEMBER"]).optional(),
});

function validate(actor: Actor, b: z.infer<typeof roleSchema>) {
  const fe = new FieldErrors();
  const name = b.name.trim();
  if (name.length < 2) fe.add("name", "Role name is required.");
  if (name.length > 40) fe.add("name", "Keep the name under 40 characters.");
  const perms = [...new Set(b.permissions)];
  const bad = perms.filter((p) => !isPermission(p));
  if (bad.length) fe.add("permissions", `Unknown permission: ${bad.join(", ")}`);
  const tier = (b.tier ?? "MEMBER") as Tier;
  if (TIER_RANK[tier] > TIER_RANK[actor.role]) fe.add("tier", "You can't create a role with more task access than your own.");
  const beyond = perms.filter((p) => !isOwner(actor) && !actor.permissions.includes(p as Permission));
  if (beyond.length) fe.add("permissions", "You can only grant permissions you have yourself.");
  fe.throwIfAny();
  // Viewing dependent areas implicitly requires their view permission.
  const set = new Set(perms as Permission[]);
  for (const p of [...set]) {
    const area = p.split(".")[0];
    const view = `${area}.view` as Permission;
    if (ALL_PERMISSIONS.includes(view)) set.add(view);
  }
  return { name, description: b.description.trim().slice(0, 200), tier, permissions: ALL_PERMISSIONS.filter((p) => set.has(p)) };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "role";

export async function createRole(actor: Actor, body: unknown) {
  assertCan(actor, "roles.manage");
  const v = validate(actor, roleSchema.parse(body));
  return runTx(async (tx) => {
    if (await tx.role.findFirst({ where: { name: { equals: v.name, mode: "insensitive" } } })) throw fail.validation({ name: "A role with this name already exists." });
    let key = slug(v.name);
    for (let i = 2; await tx.role.findUnique({ where: { key } }); i++) key = `${slug(v.name)}-${i}`;
    const r = await tx.role.create({ data: { ...v, key } });
    await logActivity(tx, { actor, action: "role.created", targetType: "ROLE", targetId: r.id, targetLabel: r.name, meta: { permissions: v.permissions } });
    return r;
  });
}

export async function updateRole(actor: Actor, id: string, body: unknown) {
  assertCan(actor, "roles.manage");
  const parsed = roleSchema.parse(body);
  return runTx(async (tx) => {
    const r = await tx.role.findUnique({ where: { id } });
    if (!r) throw fail.notFound("Role");
    const chk = canEditRole(actor, r);
    if (!chk.ok) throw fail.forbidden(chk.reason!);
    const v = validate(actor, { ...parsed, name: r.isSystem ? r.name : parsed.name, tier: r.isSystem ? r.tier : parsed.tier ?? r.tier });
    if (v.name !== r.name && (await tx.role.findFirst({ where: { name: { equals: v.name, mode: "insensitive" }, id: { not: id } } }))) throw fail.validation({ name: "A role with this name already exists." });
    const updated = await tx.role.update({ where: { id }, data: v });
    const added = v.permissions.filter((p) => !r.permissions.includes(p));
    const removed = r.permissions.filter((p) => !v.permissions.includes(p as Permission));
    await logActivity(tx, { actor, action: "role.updated", targetType: "ROLE", targetId: id, targetLabel: updated.name, meta: { added, removed, renamedFrom: r.name !== v.name ? r.name : undefined, tier: r.tier !== v.tier ? { from: r.tier, to: v.tier } : undefined } });
    return updated;
  });
}

export async function deleteRole(actor: Actor, id: string, body: unknown) {
  assertCan(actor, "roles.manage");
  const { reassignToRoleId } = z.object({ reassignToRoleId: z.string().nullish() }).parse(body ?? {});
  return runTx(async (tx) => {
    const r = await tx.role.findUnique({ where: { id }, include: { _count: { select: { users: true, invitations: { where: { status: "PENDING" } } } } } });
    if (!r) throw fail.notFound("Role");
    if (r.isSystem) throw fail.forbidden("Built-in roles can't be deleted.");
    if (r.id === actor.roleId) throw fail.forbidden("You can't delete your own role.");
    const inUse = r._count.users + r._count.invitations;
    if (inUse > 0) {
      if (!reassignToRoleId) throw fail.validation({ reassignToRoleId: `${r._count.users} user(s) and ${r._count.invitations} pending invitation(s) use this role. Pick a role to move them to.` });
      const target = await tx.role.findUnique({ where: { id: reassignToRoleId } });
      if (!target || target.id === id) throw fail.validation({ reassignToRoleId: "Pick a different role." });
      if (!canAssignRole(actor, target)) throw fail.forbidden("You can't assign that role.");
      await tx.user.updateMany({ where: { roleId: id }, data: { roleId: target.id, version: { increment: 1 } } });
      await tx.invitation.updateMany({ where: { roleId: id, status: "PENDING" }, data: { roleId: target.id } });
    }
    // Accepted/revoked invitations keep history but must not block the delete.
    const fallback = reassignToRoleId ?? (await tx.role.findUniqueOrThrow({ where: { key: "member" } })).id;
    await tx.invitation.updateMany({ where: { roleId: id }, data: { roleId: fallback } });
    await tx.role.delete({ where: { id } });
    await logActivity(tx, { actor, action: "role.deleted", targetType: "ROLE", targetId: id, targetLabel: r.name, meta: { movedUsers: r._count.users, reassignToRoleId } });
    return { ok: true };
  });
}
