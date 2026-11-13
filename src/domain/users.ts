import { z } from "zod";
import bcrypt from "bcryptjs";
import type { Prisma, UserStatus } from "@prisma/client";
import { prisma, tx as runTx, type Tx } from "@/lib/db";
import { fail } from "@/lib/errors";
import { allocateUserCode, assertCan, can, isOwner, type Actor } from "./actor";
import { logActivity } from "./activity";
import { canAssignRole } from "./roles";
import { EMAIL_RE, FieldErrors, normEmail, passwordProblem } from "./validation";

export const BCRYPT_ROUNDS = 12;

const publicUser = {
  id: true, email: true, name: true, title: true, phone: true, status: true, lastLoginAt: true, createdAt: true, updatedAt: true, version: true,
  code: true, escalationLevel: true, passwordHash: false,
  role: { select: { id: true, key: true, name: true, tier: true } },
} satisfies Prisma.UserSelect;

type TargetUser = { id: string; status: UserStatus; role: { key: string; permissions?: string[] } };

// Rules shared by edit/status/delete: never yourself for role/status/delete, only Owners touch Owners,
// and the workspace always keeps at least one active Owner.
function guardTarget(actor: Actor, target: TargetUser, what: "role" | "status" | "delete" | "edit") {
  if (target.id === actor.id && what !== "edit") throw fail.forbidden(what === "delete" ? "You can't delete your own account." : `You can't change your own ${what}.`);
  if (target.role.key === "owner" && !isOwner(actor)) throw fail.forbidden("Only an Owner can change another Owner.");
}

async function assertNotLastOwner(tx: Tx, userId: string) {
  const owners = await tx.user.count({ where: { status: "ACTIVE", role: { key: "owner" }, id: { not: userId } } });
  if (owners === 0) throw fail.blocked("This is the last active Owner. Make someone else an Owner first.");
}

export const listSchema = z.object({
  q: z.string().optional(),
  roleId: z.string().optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(),
  sort: z.enum(["name", "email", "createdAt", "lastLoginAt", "role"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(5).max(100).optional(),
});

export async function listUsers(actor: Actor, raw: unknown) {
  assertCan(actor, "users.view");
  const f = listSchema.parse(raw ?? {});
  const pageSize = f.pageSize ?? 10;
  const page = f.page ?? 1;
  const search: Prisma.UserWhereInput = f.q?.trim()
    ? { OR: [{ name: { contains: f.q.trim(), mode: "insensitive" } }, { email: { contains: f.q.trim(), mode: "insensitive" } }, { title: { contains: f.q.trim(), mode: "insensitive" } }] }
    : {};
  const base: Prisma.UserWhereInput = { ...search, ...(f.roleId ? { roleId: f.roleId } : {}) };
  const where: Prisma.UserWhereInput = { ...base, ...(f.status ? { status: f.status } : {}) };
  const dir = f.dir ?? (f.sort === "createdAt" || f.sort === "lastLoginAt" ? "desc" : "asc");
  const orderBy: Prisma.UserOrderByWithRelationInput =
    f.sort === "role" ? { role: { name: dir } } : f.sort === "lastLoginAt" ? { lastLoginAt: { sort: dir, nulls: "last" } } : { [f.sort ?? "name"]: dir };
  const [rows, total, statusCounts] = await Promise.all([
    prisma.user.findMany({ where, select: publicUser, orderBy: [orderBy, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.user.count({ where }),
    prisma.user.groupBy({ by: ["status"], where: base, _count: true }),
  ]);
  return {
    rows: rows.map((u) => ({
      ...u,
      isSelf: u.id === actor.id,
      canEdit: can(actor, "users.edit") && (u.role.key !== "owner" || isOwner(actor)),
      canChangeStatus: can(actor, "users.status") && u.id !== actor.id && (u.role.key !== "owner" || isOwner(actor)),
      canDelete: can(actor, "users.delete") && u.id !== actor.id && (u.role.key !== "owner" || isOwner(actor)),
    })),
    total, page, pageSize,
    counts: { ALL: statusCounts.reduce((s, c) => s + c._count, 0), ...Object.fromEntries(statusCounts.map((c) => [c.status, c._count])) },
  };
}

const createSchema = z.object({
  name: z.string().optional().default(""),
  email: z.string().optional().default(""),
  title: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  roleId: z.string().optional().default(""),
  password: z.string().optional().default(""),
  status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(),
  code: z.string().nullish(),
  escalationLevel: z.enum(["L1", "L2", "L3"]).nullish(),
});

// Escalation owners (L1/L2/L3) are set by Admins only; each level has exactly one person.
async function checkEscalationLevel(tx: Tx, actor: Actor, level: "L1" | "L2" | "L3" | null | undefined, userId: string | null, fe: FieldErrors) {
  if (level === undefined) return;
  if (actor.role !== "ADMIN") { fe.add("escalationLevel", "Only an Admin can set escalation levels."); return; }
  if (level && (await tx.user.findFirst({ where: { escalationLevel: level, ...(userId ? { id: { not: userId } } : {}) } })))
    fe.add("escalationLevel", `${level} is already assigned. Clear it from that person first.`);
}

function checkCode(code: string | null | undefined, fe: FieldErrors) {
  if (code && !/^[A-Za-z]{3}$/.test(code.trim())) fe.add("code", "Use exactly 3 letters.");
}

async function validateCommon(tx: Tx, actor: Actor, b: { name: string; email: string; title: string; phone: string; roleId: string }, excludeId?: string) {
  const fe = new FieldErrors();
  const name = b.name.trim();
  const email = normEmail(b.email);
  if (name.length < 2) fe.add("name", "Enter the person's full name.");
  if (name.length > 80) fe.add("name", "Keep the name under 80 characters.");
  if (!email) fe.add("email", "Email is required.");
  else if (!EMAIL_RE.test(email)) fe.add("email", "Enter a valid email address, like name@company.com.");
  else if (await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) } })) fe.add("email", "Another user already has this email.");
  const phone = b.phone.trim();
  if (phone && !/^[+()\d\s-]{6,20}$/.test(phone)) fe.add("phone", "Use digits, spaces, +, - or brackets.");
  const role = b.roleId ? await tx.role.findUnique({ where: { id: b.roleId } }) : null;
  if (!b.roleId) fe.add("roleId", "Pick a role.");
  else if (!role) fe.add("roleId", "That role no longer exists.");
  else if (!canAssignRole(actor, role)) fe.add("roleId", "You can't assign a role with more access than your own.");
  return { fe, data: { name, email, title: b.title.trim().slice(0, 80), phone, roleId: b.roleId }, role };
}

export async function createUser(actor: Actor, body: unknown) {
  assertCan(actor, "users.create");
  const b = createSchema.parse(body);
  const { fe, data } = await validateCommon(prisma, actor, b);
  // Google-only accounts have no password; when one is given it must be strong.
  const pw = b.password ? passwordProblem(b.password) : null;
  if (pw) fe.add("password", pw);
  checkCode(b.code, fe);
  if (b.code && (await prisma.user.findUnique({ where: { code: b.code.trim().toUpperCase() } }))) fe.add("code", "Another user has this code.");
  await checkEscalationLevel(prisma as unknown as Tx, actor, b.escalationLevel ?? undefined, null, fe);
  if (!fe.e.email && (await prisma.invitation.findFirst({ where: { email: { equals: normEmail(b.email), mode: "insensitive" }, status: "PENDING" } })))
    fe.add("email", "This person has a pending invitation. Revoke it first or let them accept it.");
  fe.throwIfAny();
  const passwordHash = b.password ? await bcrypt.hash(b.password, BCRYPT_ROUNDS) : null;
  return runTx(async (tx) => {
    const code = await allocateUserCode(tx, data.name, b.code);
    const u = await tx.user.create({ data: { ...data, passwordHash, code, escalationLevel: b.escalationLevel ?? null, status: b.status ?? "ACTIVE", createdById: actor.id }, select: publicUser });
    await logActivity(tx, { actor, action: "user.created", targetType: "USER", targetId: u.id, targetLabel: u.name, meta: { email: u.email, role: u.role.name } });
    return u;
  });
}

const updateSchema = z.object({
  expectedVersion: z.number().int(),
  name: z.string(), email: z.string(), title: z.string().optional().default(""), phone: z.string().optional().default(""), roleId: z.string(),
  escalationLevel: z.enum(["L1", "L2", "L3"]).nullish(),
});

export async function updateUser(actor: Actor, id: string, body: unknown) {
  assertCan(actor, "users.edit");
  const b = updateSchema.parse(body);
  return runTx(async (tx) => {
    const before = await tx.user.findUnique({ where: { id }, include: { role: true } });
    if (!before) throw fail.notFound("User");
    guardTarget(actor, before, "edit");
    const { fe, data, role } = await validateCommon(tx, actor, b, id);
    if (b.escalationLevel !== undefined && b.escalationLevel !== before.escalationLevel) await checkEscalationLevel(tx, actor, b.escalationLevel, id, fe);
    const levelChange = b.escalationLevel !== undefined && b.escalationLevel !== before.escalationLevel ? { escalationLevel: b.escalationLevel } : {};
    if (b.roleId !== before.roleId) {
      if (id === actor.id) fe.add("roleId", "You can't change your own role.");
      else if (before.role.key === "owner" && role?.key !== "owner") await assertNotLastOwner(tx, id);
    }
    fe.throwIfAny();
    const r = await tx.user.updateMany({ where: { id, version: b.expectedVersion }, data: { ...data, ...levelChange, version: { increment: 1 } } });
    if ("escalationLevel" in levelChange) await logActivity(tx, { actor, action: "user.escalation_level_changed", targetType: "USER", targetId: id, targetLabel: data.name, meta: { from: before.escalationLevel, to: levelChange.escalationLevel } });
    if (r.count === 0) throw fail.stale(await tx.user.findUnique({ where: { id }, select: publicUser }));
    const changed = (["name", "email", "title", "phone"] as const).filter((k) => before[k] !== data[k]);
    if (changed.length) await logActivity(tx, { actor, action: "user.updated", targetType: "USER", targetId: id, targetLabel: data.name, meta: { fields: changed } });
    if (b.roleId !== before.roleId) await logActivity(tx, { actor, action: "user.role_changed", targetType: "USER", targetId: id, targetLabel: data.name, meta: { from: before.role.name, to: role!.name } });
    return tx.user.findUniqueOrThrow({ where: { id }, select: publicUser });
  });
}

export async function setUserStatus(actor: Actor, id: string, body: unknown) {
  assertCan(actor, "users.status");
  const { status, reason } = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]), reason: z.string().nullish() }).parse(body);
  return runTx(async (tx) => {
    const u = await tx.user.findUnique({ where: { id }, include: { role: true } });
    if (!u) throw fail.notFound("User");
    guardTarget(actor, u, "status");
    if (u.status === status) return tx.user.findUniqueOrThrow({ where: { id }, select: publicUser });
    if (status !== "ACTIVE" && u.role.key === "owner") await assertNotLastOwner(tx, id);
    if (status !== "ACTIVE" && !reason?.trim()) throw fail.validation({ reason: "Say why, so other admins know." });
    // Reactivating also clears any sign-in lockout.
    await tx.user.update({ where: { id }, data: { status, version: { increment: 1 }, ...(status === "ACTIVE" ? { failedLoginCount: 0, lockedUntil: null } : {}) } });
    await logActivity(tx, { actor, action: "user.status_changed", targetType: "USER", targetId: id, targetLabel: u.name, meta: { from: u.status, to: status, reason: reason?.trim() || undefined } });
    return tx.user.findUniqueOrThrow({ where: { id }, select: publicUser });
  });
}

export async function deleteUser(actor: Actor, id: string, body: unknown) {
  assertCan(actor, "users.delete");
  const { confirmEmail } = z.object({ confirmEmail: z.string().optional().default("") }).parse(body ?? {});
  return runTx(async (tx) => {
    const u = await tx.user.findUnique({ where: { id }, include: { role: true } });
    if (!u) throw fail.notFound("User");
    guardTarget(actor, u, "delete");
    if (normEmail(confirmEmail) !== u.email.toLowerCase()) throw fail.validation({ confirmEmail: "Type the user's email exactly to confirm." });
    if (u.role.key === "owner") await assertNotLastOwner(tx, id);
    const owned = await tx.task.count({ where: { ownerId: id } }) + await tx.project.count({ where: { ownerId: id } }) + await tx.recurringSeries.count({ where: { ownerId: id } }) + await tx.subtask.count({ where: { ownerId: id } });
    if (owned) throw fail.blocked("This person owns tasks, projects or recurring series. Deactivate them instead so their history stays intact.");
    await tx.user.delete({ where: { id } });
    // The activity log keeps the record of who existed and who removed them.
    await logActivity(tx, { actor, action: "user.deleted", targetType: "USER", targetId: id, targetLabel: u.name, meta: { email: u.email, role: u.role.name } });
    return { ok: true };
  });
}

export async function getProfile(actor: Actor) {
  return prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: publicUser });
}

export async function updateProfile(actor: Actor, body: unknown) {
  const b = z.object({ name: z.string(), title: z.string().optional().default(""), phone: z.string().optional().default("") }).parse(body);
  const fe = new FieldErrors();
  if (b.name.trim().length < 2) fe.add("name", "Enter your full name.");
  if (b.phone.trim() && !/^[+()\d\s-]{6,20}$/.test(b.phone.trim())) fe.add("phone", "Use digits, spaces, +, - or brackets.");
  fe.throwIfAny();
  return runTx(async (tx) => {
    const u = await tx.user.update({ where: { id: actor.id }, data: { name: b.name.trim(), title: b.title.trim(), phone: b.phone.trim(), version: { increment: 1 } }, select: publicUser });
    await logActivity(tx, { actor, action: "user.updated", targetType: "USER", targetId: actor.id, targetLabel: u.name, meta: { self: true } });
    return u;
  });
}

export async function changePassword(actor: Actor, body: unknown) {
  const b = z.object({ current: z.string(), next: z.string() }).parse(body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  const fe = new FieldErrors();
  if (!u.passwordHash || !(await bcrypt.compare(b.current, u.passwordHash))) fe.add("current", "Current password is incorrect.");
  const pw = passwordProblem(b.next);
  if (pw) fe.add("next", pw);
  else if (b.next === b.current) fe.add("next", "Choose a password you haven't just used.");
  fe.throwIfAny();
  const hash = await bcrypt.hash(b.next, BCRYPT_ROUNDS);
  return runTx(async (tx) => {
    await tx.user.update({ where: { id: actor.id }, data: { passwordHash: hash, version: { increment: 1 } } });
    await logActivity(tx, { actor, action: "user.password_changed", targetType: "USER", targetId: actor.id, targetLabel: actor.name });
    return { ok: true };
  });
}
