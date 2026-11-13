import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedBaseline, seedPocs, seedTeam } from "./seed-data";

// Always: roles, channels, SLA and score policies, and the first Owner (SEED_OWNER_EMAIL).
// SEED_SAMPLE=true on an empty task table also adds the demo team (password Password123) and demo work.
const prisma = new PrismaClient();

async function owner() {
  const email = (process.env.SEED_OWNER_EMAIL ?? "owner@example.com").toLowerCase();
  if (await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } })) return;
  const password = process.env.SEED_OWNER_PASSWORD ?? (process.env.SEED_OWNER_EMAIL ? null : "ChangeMe123");
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "owner" } });
  const name = process.env.SEED_OWNER_NAME ?? "Workspace Owner";
  await prisma.user.create({ data: { email, name, code: "OWN", title: "Owner", passwordHash: password ? await bcrypt.hash(password, 12) : null, roleId: role.id } });
  console.log(`Owner account: ${email}${password ? ` / ${password === "ChangeMe123" ? "ChangeMe123 (change it after first sign-in)" : "(from SEED_OWNER_PASSWORD)"}` : " (sign in with Google)"}`);
}

async function sample() {
  const { loadActor } = await import("../src/domain/actor");
  const { createTask, changeStatus } = await import("../src/domain/tasks");
  const { requestTransfer, requestExtension } = await import("../src/domain/governance");
  const { triggerEscalation } = await import("../src/domain/escalation");
  const { createProject } = await import("../src/domain/projects");
  const { createSeries } = await import("../src/domain/recurrence");
  const { addDays, iso, todayBiz } = await import("../src/lib/dates");

  await seedTeam(prisma, "Password123");
  await seedPocs(prisma);
  const users = await prisma.user.findMany();
  const A = async (code: string) => (await loadActor(users.find((x) => x.code === code)!.id))!;
  const ch = Object.fromEntries((await prisma.channel.findMany()).map((c) => [c.name, c.id]));
  const ws = Object.fromEntries((await prisma.workstream.findMany()).map((w) => [w.name, w.id]));
  const poc = Object.fromEntries((await prisma.poc.findMany()).map((p) => [p.name, p.id]));
  const d = (n: number) => iso(addDays(todayBiz(), n))!;
  const harsh = await A("HSH"), dilip = await A("DLP");

  const q4 = await createProject(harsh, { name: "Q4 Growth", ownerId: harsh.id, description: "Festive-season growth push across quick-commerce and fashion marketplaces.", startDate: d(-30), targetDate: d(45), channels: ["Blinkit", "Swiggy", "Myntra"] });
  const catalog = await createProject(dilip, { name: "Catalog Hygiene FY27", ownerId: (await A("YOG")).id, description: "Fix suppressed listings, image compliance and attribute gaps.", startDate: d(-20), targetDate: d(60), channels: ["Amazon", "Flipkart"] });

  // name, channel, owner, priority, assignedOffset, deadlineOffset, status, project, pocType, poc, followup
  const specs: [string, string, string, number, number, number, string, string | null, string | null, string | null, number | null][] = [
    ["Resolve suppressed hero SKUs on Amazon", "Amazon", "YOG", 0, -6, -1, "IN_PROGRESS", catalog.id, "E", "Amazon Seller Support", 0],
    ["Blinkit festive banner go-live", "Blinkit", "PRG", 1, -4, 2, "IN_PROGRESS", q4.id, "WB", "Brand Design Team", 1],
    ["Swiggy Instamart pricing parity audit", "Swiggy", "SUR", 2, -3, 1, "NOT_STARTED", q4.id, null, null, null],
    ["Myntra size-chart corrections (42 styles)", "Myntra", "RIY", 2, -8, -2, "IN_PROGRESS", q4.id, "I", "Warehouse Ops", null],
    ["Nykaa new launch listing — 12 SKUs", "Nykaa", "PRT", 3, -2, 5, "NOT_STARTED", null, null, null, null],
    ["Flipkart return-reason analysis", "Flipkart", "RIT", 3, -10, -4, "COMPLETED", catalog.id, null, null, null],
    ["Ajio catalog image compliance", "Ajio", "YOG", 4, -12, -5, "COMPLETED", catalog.id, null, null, null],
    ["Tata CLiQ onboarding documents", "Tata CLiQ", "PRG", 3, -15, -7, "COMPLETED", null, null, null, null],
    ["Amazon A+ content refresh", "Amazon", "SUR", 5, -1, 6, "NOT_STARTED", null, "WB", "Brand Merchandising", 3],
    ["Weekly inventory sync check — Blinkit dark stores", "Blinkit", "RIT", 2, -5, -1, "ON_HOLD", q4.id, "E", "Blinkit Catalog Team", 2],
    ["Credit note reconciliation — Myntra Oct", "Myntra", "RIY", 1, -9, -3, "COMPLETED", null, null, null, null],
    ["Ads budget re-allocation for Diwali week", "Amazon", "HSH", 1, -3, 1, "IN_PROGRESS", q4.id, null, null, null],
    ["Marketplace SLA policy review", "General", "DLP", 4, -2, 10, "NOT_STARTED", null, null, null, null],
    ["Flipkart Big Billion Days post-mortem", "Flipkart", "PRT", 3, -14, -9, "COMPLETED", null, null, null, null],
    ["Swiggy listing photo shoot coordination", "Swiggy", "SUR", 4, -6, 2, "IN_PROGRESS", q4.id, "E", "Swiggy shoot vendor (Lens & Co)", 1],
  ];

  const ids: string[] = [];
  for (const [name, channel, owner, priority, aOff, dOff, status, projectId, pocType, pocName, fu] of specs) {
    const actor = owner === "DLP" ? dilip : harsh;
    const { result } = await createTask(actor, {
      name, channelId: ch[channel], ownerId: (await A(owner)).id, priority, deadline: d(Math.max(dOff, 0)), projectId,
      pocType, ...(pocName && poc[pocName] ? { pocId: poc[pocName] } : { pendingFrom: pocName }),
      followupDate: fu === null ? null : d(fu),
      workstreamId: name.includes("catalog") || name.includes("listing") ? ws["Catalog & Listings"] : null,
      p0Justification: priority === 0 ? "Hero SKU suppressed — direct revenue loss" : undefined,
    });
    const t = result.task;
    ids.push(t.id);
    await prisma.task.update({ where: { id: t.id }, data: { assignedDate: new Date(`${d(aOff)}T00:00:00Z`), deadline: new Date(`${d(dOff)}T00:00:00Z`), originalDeadline: new Date(`${d(dOff)}T00:00:00Z`) } });
    const o = await A(owner);
    const v = async () => (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).version;
    if (status === "IN_PROGRESS" || status === "ON_HOLD") await changeStatus(o, t.id, { to: "IN_PROGRESS", expectedVersion: await v() });
    if (status === "ON_HOLD") await changeStatus(o, t.id, { to: "ON_HOLD", expectedVersion: await v() });
    if (status === "COMPLETED") {
      await changeStatus(o, t.id, { to: "COMPLETED", expectedVersion: await v() });
      const late = name.includes("return-reason") || name.includes("post-mortem");
      await prisma.task.update({ where: { id: t.id }, data: { completedAt: new Date(`${d(late ? dOff + 2 : dOff - 1)}T09:00:00Z`) } });
    }
  }
  await triggerEscalation(await A("YOG"), ids[0], { level: "L2", reason: "Amazon hasn't responded to the suppression case for 3 days" });
  await triggerEscalation(await A("RIT"), ids[9], { level: "L1", reason: "Dark store inventory feed broken on Blinkit side" });
  await requestExtension(await A("RIY"), ids[3], { requestedDeadline: d(4), reason: "Waiting on revised size data from brand team", waiverReason: "Dependency on brand team input" });
  await requestExtension(await A("RIT"), ids[5], { requestedDeadline: d(-2), reason: "Return data from Flipkart arrived 2 days late" });
  await requestTransfer(await A("PRT"), ids[4], { toUserId: (await A("RIY")).id, reason: "Riya handles Nykaa beauty listings" });

  await createSeries(await A("PRG"), { title: "Daily Blinkit OOS check", channelId: ch["Blinkit"], ownerId: (await A("PRG")).id, priority: 3, cadence: "DAILY", startDate: d(0), workingDaysOnly: true });
  await createSeries(harsh, { title: "Weekly marketplace performance review", channelId: ch["General"], ownerId: harsh.id, priority: 2, cadence: "WEEKLY", weekdays: ["MON"], startDate: d(0), deadlineOffsetDays: 1 });
  console.log(`Sample data: ${TEAM_SIZE()} team members (password Password123), ${ids.length} tasks, 2 projects, 2 recurring series.`);
}
const TEAM_SIZE = () => 8;

async function main() {
  await seedBaseline(prisma);
  await owner();
  if (process.env.SEED_SAMPLE === "true" && (await prisma.task.count()) === 0) await sample();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
