import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createUser, deleteUser, listUsers, setUserStatus, updateUser, changePassword } from "@/domain/users";
import { createRole, deleteRole, listRoles, updateRole } from "@/domain/roles";
import { verifyCredentials } from "@/lib/auth";
import { loadActor } from "@/domain/actor";
import { expectError, mkUser, roleId } from "./helpers";

const base = async (over: Record<string, unknown> = {}) => ({ name: "Priya Sharma", email: "Priya@Example.com", title: "Analyst", phone: "+91 98765 43210", roleId: await roleId("member"), password: "Secret123", ...over });

describe("user management", () => {
  it("creates a user, normalises email, logs activity, and validates every field", async () => {
    const admin = await mkUser("admin");
    const u = await createUser(admin, await base());
    expect(u.email).toBe("priya@example.com");
    expect(u.role.key).toBe("member");
    expect(await prisma.activityLog.count({ where: { action: "user.created" } })).toBe(1);
    const err = await expectError(createUser(admin, { name: "x", email: "bad", phone: "abc", roleId: "", password: "short" }), "VALIDATION");
    expect(Object.keys(err.fields!).sort()).toEqual(["email", "name", "password", "phone", "roleId"]);
    await expectError(createUser(admin, await base({ email: "PRIYA@example.com" })), "VALIDATION", "email");
  });

  it("enforces permissions server-side and blocks privilege escalation", async () => {
    const member = await mkUser("member");
    await expectError(createUser(member, await base()), "FORBIDDEN");
    await expectError(listUsers(member, {}), "FORBIDDEN");
    const manager = await mkUser("leadership");
    await expectError(createUser(manager, await base()), "FORBIDDEN");
    const target = await mkUser("member");
    const t = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    await expectError(updateUser(manager, target.id, { expectedVersion: t.version, name: t.name, email: t.email, roleId: await roleId("admin") }), "FORBIDDEN");
    // An editor without Admin tier can't hand out the Admin role, and only Admins set escalation levels.
    await prisma.role.update({ where: { key: "leadership" }, data: { permissions: { push: "users.edit" } } });
    const editor = (await loadActor(manager.id))!;
    await expectError(updateUser(editor, target.id, { expectedVersion: t.version, name: t.name, email: t.email, roleId: await roleId("admin") }), "VALIDATION", "roleId");
    await expectError(updateUser(editor, target.id, { expectedVersion: t.version, name: t.name, email: t.email, roleId: t.roleId, escalationLevel: "L1" }), "VALIDATION", "escalationLevel");
  });

  it("search, filter by role/status, sort and paginate with status counts", async () => {
    const admin = await mkUser("admin", "zed@example.com", "Zed Admin");
    for (const [n, r] of [["Alice Moon", "member"], ["Bob Stone", "leadership"], ["Carla Moon", "member"]] as const) await createUser(admin, await base({ name: n, email: `${n.split(" ")[0].toLowerCase()}@example.com`, roleId: await roleId(r) }));
    const bob = await prisma.user.findFirstOrThrow({ where: { name: "Bob Stone" } });
    await setUserStatus(admin, bob.id, { status: "SUSPENDED", reason: "Left club" });
    const moon = await listUsers(admin, { q: "moon" });
    expect(moon.rows.map((r) => r.name)).toEqual(["Alice Moon", "Carla Moon"]);
    const members = await listUsers(admin, { roleId: await roleId("member"), sort: "name", dir: "desc" });
    expect(members.rows.map((r) => r.name)).toEqual(["Carla Moon", "Alice Moon"]);
    const susp = await listUsers(admin, { status: "SUSPENDED" });
    expect(susp.rows.map((r) => r.name)).toEqual(["Bob Stone"]);
    expect(susp.counts).toMatchObject({ ALL: 4, ACTIVE: 3, SUSPENDED: 1 });
    const page2 = await listUsers(admin, { pageSize: 5, page: 1 });
    expect(page2.total).toBe(4);
  });

  it("status changes need a reason, block sign-in, and protect self and last owner", async () => {
    const owner = await mkUser("owner");
    const admin = await mkUser("admin");
    const m = await createUser(admin, await base());
    await expectError(setUserStatus(admin, m.id, { status: "SUSPENDED" }), "VALIDATION", "reason");
    await setUserStatus(admin, m.id, { status: "SUSPENDED", reason: "Investigation" });
    expect((await verifyCredentials("priya@example.com", "Secret123")).ok).toBe(false);
    expect(await loadActor(m.id)).toBeNull();
    await setUserStatus(admin, m.id, { status: "ACTIVE" });
    expect((await verifyCredentials("priya@example.com", "Secret123")).ok).toBe(true);
    await expectError(setUserStatus(admin, admin.id, { status: "SUSPENDED", reason: "x" }), "FORBIDDEN");
    await expectError(setUserStatus(admin, owner.id, { status: "SUSPENDED", reason: "x" }), "FORBIDDEN");
    const owner2 = await mkUser("owner");
    await setUserStatus(owner, owner2.id, { status: "DEACTIVATED", reason: "Handover" });
    const o = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    await expectError(updateUser(owner2.id === owner.id ? owner : owner, owner.id, { expectedVersion: o.version, name: o.name, email: o.email, roleId: await roleId("admin") }), "VALIDATION", "roleId");
  });

  it("edit uses optimistic concurrency; delete requires typed email and keeps the audit trail", async () => {
    const admin = await mkUser("admin");
    const u = await createUser(admin, await base());
    await updateUser(admin, u.id, { expectedVersion: u.version, name: "Priya S.", email: u.email, roleId: u.role.id });
    await expectError(updateUser(admin, u.id, { expectedVersion: u.version, name: "Stale", email: u.email, roleId: u.role.id }), "STALE");
    await expectError(deleteUser(admin, u.id, { confirmEmail: "wrong@example.com" }), "VALIDATION", "confirmEmail");
    await expectError(deleteUser(admin, admin.id, { confirmEmail: admin.email }), "FORBIDDEN");
    await deleteUser(admin, u.id, { confirmEmail: "PRIYA@example.com" });
    expect(await prisma.user.findUnique({ where: { id: u.id } })).toBeNull();
    expect(await prisma.activityLog.count({ where: { targetId: u.id } })).toBe(3);
    await expect(prisma.activityLog.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it("locks the account after 5 failed sign-ins and changes password with the current one", async () => {
    const m = await mkUser("member", "lock@example.com");
    for (let i = 0; i < 4; i++) expect((await verifyCredentials("lock@example.com", "nope")).reason).toBe("INVALID");
    expect((await verifyCredentials("lock@example.com", "nope")).reason).toBe("LOCKED");
    expect((await verifyCredentials("lock@example.com", "Password123")).reason).toBe("LOCKED");
    await prisma.user.update({ where: { id: m.id }, data: { lockedUntil: null } });
    await expectError(changePassword(m, { current: "bad", next: "NewPass123" }), "VALIDATION", "current");
    await changePassword(m, { current: "Password123", next: "NewPass123" });
    expect((await verifyCredentials("LOCK@example.com", "NewPass123")).ok).toBe(true);
  });
});

describe("roles & permissions", () => {
  it("creates custom roles, adds implied view permissions, and stops granting what you don't have", async () => {
    const owner = await mkUser("owner");
    const r = await createRole(owner, { name: "Coach", description: "Coaching staff", permissions: ["users.edit"] });
    expect(r.permissions).toEqual(["users.view", "users.edit"]);
    expect(r.tier).toBe("MEMBER");
    await expectError(createRole(owner, { name: "coach", permissions: [] }), "VALIDATION", "name");
    const lead = await mkUser("leadership");
    await prisma.role.update({ where: { key: "leadership" }, data: { permissions: { push: "roles.manage" } } });
    await expectError(createRole((await loadActor(lead.id))!, { name: "Super", permissions: [], tier: "ADMIN" }), "VALIDATION", "tier");
    await expectError(createRole(owner, { name: "Bad", permissions: ["nuke.everything"] }), "VALIDATION", "permissions");
    const admin = await mkUser("admin");
    await prisma.role.update({ where: { key: "admin" }, data: { permissions: { set: ["roles.view", "roles.manage", "users.view"] } } });
    const limited = (await loadActor(admin.id))!;
    await expectError(createRole(limited, { name: "Too much", permissions: ["users.delete"] }), "VALIDATION", "permissions");
  });

  it("protects Owner and your own role; permission changes apply on the next request", async () => {
    const owner = await mkUser("owner");
    const admin = await mkUser("admin");
    const roles = await listRoles(admin);
    expect(roles.find((x) => x.key === "owner")!.editable).toBe(false);
    expect(roles.find((x) => x.key === "admin")!.editable).toBe(false);
    await expectError(updateRole(admin, await roleId("owner"), { name: "Owner", permissions: ["scores.view"] }), "FORBIDDEN");
    const member = await mkUser("member");
    await updateRole(owner, await roleId("member"), { name: "Member", permissions: ["users.view"] });
    expect((await loadActor(member.id))!.permissions).toContain("users.view");
  });

  it("deleting a role in use requires reassigning its users and pending invites", async () => {
    const owner = await mkUser("owner");
    const r = await createRole(owner, { name: "Scout", permissions: [] });
    const u = await createUser(owner, await base({ roleId: r.id }));
    await expectError(deleteRole(owner, r.id, {}), "VALIDATION", "reassignToRoleId");
    await expectError(deleteRole(owner, await roleId("member"), {}), "FORBIDDEN");
    await deleteRole(owner, r.id, { reassignToRoleId: await roleId("member") });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { role: true } })).role.key).toBe("member");
  });
});
