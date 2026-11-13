import type { EscalationLevel } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import type { Permission, Tier } from "./permissions";

export interface Actor {
  id: string;
  name: string;
  email: string;
  code: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  // Task-workspace tier (rbac.ts MATRIX). Named `role` for the operation matrix.
  role: Tier;
  escalationLevel: EscalationLevel | null;
  permissions: Permission[];
}

// Used by jobs (reconciliation, imports) that read across the whole team.
export const SYSTEM_ACTOR: Actor = { id: "system", name: "system", email: "", code: "SYS", roleId: "", roleKey: "system", roleName: "System", role: "ADMIN", escalationLevel: null, permissions: [] };

export const isOwner = (a: Pick<Actor, "roleKey">) => a.roleKey === "owner";

export function can(a: Actor, p: Permission) {
  return a.permissions.includes(p);
}

export function assertCan(a: Actor, ...perms: Permission[]) {
  for (const p of perms) if (!can(a, p)) throw fail.forbidden("You don't have permission to do this.");
}

// Role, tier and status are re-read on every request so permission changes apply immediately.
export async function loadActor(userId: string, db: Tx | typeof prisma = prisma): Promise<Actor | null> {
  const u = await db.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!u || u.status !== "ACTIVE") return null;
  return {
    id: u.id, name: u.name, email: u.email, code: u.code, roleId: u.roleId, roleKey: u.role.key, roleName: u.role.name,
    role: u.role.tier, escalationLevel: u.escalationLevel, permissions: u.role.permissions as Permission[],
  };
}

// Unique 3-letter code from the name (e.g. "Harsh Shah" → HSH), falling back to letter variations.
export async function allocateUserCode(db: Tx | typeof prisma, name: string, wanted?: string | null) {
  const letters = name.toUpperCase().replace(/[^A-Z ]/g, "").trim();
  const words = letters.split(/\s+/).filter(Boolean);
  const flat = letters.replace(/ /g, "") || "USR";
  const candidates = new Set<string>();
  if (wanted && /^[A-Za-z]{3}$/.test(wanted)) candidates.add(wanted.toUpperCase());
  if (words.length >= 2) candidates.add((words[0][0] + words[0][words[0].length - 1] + words[1][0]).slice(0, 3));
  candidates.add((flat + "XXX").slice(0, 3));
  for (let i = 1; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) candidates.add(flat[0] + flat[i] + flat[j]);
  for (const c of candidates) if (c.length === 3 && !(await db.user.findUnique({ where: { code: c } }))) return c;
  for (let n = 0; n < 17576; n++) {
    const c = String.fromCharCode(65 + Math.floor(n / 676), 65 + (Math.floor(n / 26) % 26), 65 + (n % 26));
    if (!(await db.user.findUnique({ where: { code: c } }))) return c;
  }
  throw new Error("No free user codes");
}
