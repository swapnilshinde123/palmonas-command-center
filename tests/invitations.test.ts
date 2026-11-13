import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { acceptInvitation, listInvitations, previewInvitation, resendInvitation, revokeInvitation, sendInvitations } from "@/domain/invitations";
import { setTransportForTests } from "@/domain/email";
import { verifyCredentials } from "@/lib/auth";
import { expectError, mkUser, roleId } from "./helpers";

const tokenOf = (link: string) => link.split("/invite/")[1];

describe("invitations", () => {
  it("sends to several addresses, skips existing users and live invites, emails each with a working link", async () => {
    const admin = await mkUser("admin");
    await mkUser("member", "taken@example.com");
    const r = await sendInvitations(admin, { emails: "a@example.com, B@example.com; taken@example.com a@example.com", roleId: await roleId("member"), message: "Welcome to the squad" });
    expect(r.sent.sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(r.skipped).toEqual([{ email: "taken@example.com", reason: "Already has an account" }]);
    const mails = await prisma.emailLog.findMany({ where: { kind: "invitation" } });
    expect(mails).toHaveLength(2);
    expect(mails[0].html).toContain("/invite/");
    expect(mails[0].html).toContain("Welcome to the squad");
    const again = await expectError(sendInvitations(admin, { emails: ["a@example.com"], roleId: await roleId("member") }), "VALIDATION", "emails");
    expect(again.fields!.emails).toMatch(/Resend/);
    // Tokens are stored hashed: the raw token never appears in the database.
    const inv = await prisma.invitation.findFirstOrThrow({ where: { email: "a@example.com" } });
    expect(inv.tokenHash).not.toBe(tokenOf(r.links!["a@example.com"]));
  });

  it("validates input and blocks inviting to a role above your own", async () => {
    const manager = await mkUser("leadership");
    const e = await expectError(sendInvitations(manager, { emails: "nope, ok@example.com", roleId: await roleId("admin"), message: "x".repeat(501) }), "VALIDATION");
    expect(Object.keys(e.fields!).sort()).toEqual(["emails", "message", "roleId"]);
    const member = await mkUser("member");
    await expectError(sendInvitations(member, { emails: "ok@example.com", roleId: await roleId("member") }), "FORBIDDEN");
  });

  it("accept creates the account with the invited role, signs in, and the link can't be reused", async () => {
    const admin = await mkUser("admin");
    const r = await sendInvitations(admin, { emails: "new@example.com", roleId: await roleId("leadership") });
    const token = tokenOf(r.links!["new@example.com"]);
    expect(await previewInvitation(token)).toMatchObject({ state: "PENDING", email: "new@example.com", roleName: "Leadership" });
    await expectError(acceptInvitation(token, { name: "N", password: "short", confirm: "x" }), "VALIDATION");
    await expectError(acceptInvitation(token, { name: "New Person", password: "Secret123", confirm: "Secret124" }), "VALIDATION", "confirm");
    await acceptInvitation(token, { name: "New Person", password: "Secret123", confirm: "Secret123" });
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "new@example.com" }, include: { role: true } });
    expect(u.role.key).toBe("leadership");
    expect((await verifyCredentials("new@example.com", "Secret123")).ok).toBe(true);
    await expectError(acceptInvitation(token, { name: "Again", password: "Secret123", confirm: "Secret123" }), "CONFLICT");
    expect((await previewInvitation(token)).state).toBe("ACCEPTED");
    expect((await previewInvitation("garbage-token-that-is-long-enough")).state).toBe("INVALID");
  });

  it("expired invites show as Expired, can't be accepted, and Resend issues a new link and expiry", async () => {
    const admin = await mkUser("admin");
    const r = await sendInvitations(admin, { emails: "late@example.com", roleId: await roleId("member") });
    const oldToken = tokenOf(r.links!["late@example.com"]);
    const inv = await prisma.invitation.findFirstOrThrow({ where: { email: "late@example.com" } });
    await prisma.invitation.update({ where: { id: inv.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await listInvitations(admin, { status: "EXPIRED" })).rows.map((x) => x.email)).toEqual(["late@example.com"]);
    await expectError(acceptInvitation(oldToken, { name: "Late One", password: "Secret123", confirm: "Secret123" }), "CONFLICT");
    const re = await resendInvitation(admin, inv.id);
    expect(re.ok).toBe(true);
    const after = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.sentCount).toBe(2);
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await previewInvitation(oldToken)).state).toBe("INVALID");
    await acceptInvitation(tokenOf(re.link!), { name: "Late One", password: "Secret123", confirm: "Secret123" });
    const counts = (await listInvitations(admin, {})).counts;
    expect(counts).toMatchObject({ ACCEPTED: 1, EXPIRED: 0, PENDING: 0 });
  });

  it("revoke stops the link; revoked can't be resent; status counts track every state", async () => {
    const admin = await mkUser("admin");
    const r = await sendInvitations(admin, { emails: "x@example.com, y@example.com", roleId: await roleId("member") });
    const x = await prisma.invitation.findFirstOrThrow({ where: { email: "x@example.com" } });
    await revokeInvitation(admin, x.id);
    await expectError(revokeInvitation(admin, x.id), "CONFLICT");
    await expectError(resendInvitation(admin, x.id), "CONFLICT");
    expect((await previewInvitation(tokenOf(r.links!["x@example.com"]))).state).toBe("REVOKED");
    await expectError(acceptInvitation(tokenOf(r.links!["x@example.com"]), { name: "Xavier", password: "Secret123", confirm: "Secret123" }), "CONFLICT");
    // A new invite to a revoked address is allowed.
    await sendInvitations(admin, { emails: "x@example.com", roleId: await roleId("member") });
    expect((await listInvitations(admin, {})).counts).toMatchObject({ PENDING: 2, REVOKED: 1, ALL: 3 });
  });

  it("records failed email delivery so the admin can resend", async () => {
    const admin = await mkUser("admin");
    setTransportForTests({ sendMail: async () => { throw new Error("SMTP down"); } } as never);
    const r = await sendInvitations(admin, { emails: "fail@example.com", roleId: await roleId("member") });
    setTransportForTests(null);
    expect(r.failed[0]).toMatchObject({ email: "fail@example.com", error: "SMTP down" });
    const row = (await listInvitations(admin, {})).rows[0];
    expect(row.lastEmailOk).toBe(false);
    expect(row.canResend).toBe(true);
    expect((await resendInvitation(admin, row.id)).ok).toBe(true);
  });

  it("concurrent accepts of the same link create exactly one account", async () => {
    const admin = await mkUser("admin");
    const r = await sendInvitations(admin, { emails: "race@example.com", roleId: await roleId("member") });
    const t = tokenOf(r.links!["race@example.com"]);
    const res = await Promise.allSettled([1, 2, 3].map(() => acceptInvitation(t, { name: "Race Car", password: "Secret123", confirm: "Secret123" })));
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: "race@example.com" } })).toBe(1);
  });
});
