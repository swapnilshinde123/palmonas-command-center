import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { SYSTEM_ROLES } from "../src/domain/permissions";
import { DEFAULT_POLICY } from "../src/domain/scorecard";

// Built-in roles; Owner always holds every permission. System role tiers are fixed.
export async function seedRoles(prisma: PrismaClient) {
  for (const r of SYSTEM_ROLES) {
    await prisma.role.upsert({
      where: { key: r.key },
      create: { key: r.key, name: r.name, description: r.description, permissions: r.permissions, tier: r.tier, isSystem: true },
      update: { tier: r.tier, ...(r.key === "owner" ? { permissions: r.permissions } : {}) },
    });
  }
}

export const CHANNELS = ["Amazon", "Blinkit", "Swiggy", "Myntra", "Nykaa", "Flipkart", "Tata CLiQ", "Ajio", "General"];
export const WORKSTREAMS = ["Catalog & Listings", "Advertising", "Inventory & Supply", "Finance & Reconciliation", "Customer Experience"];

// Idempotent reference data, safe on production.
export async function seedBaseline(prisma: PrismaClient) {
  await seedRoles(prisma);
  for (const [i, name] of CHANNELS.entries()) await prisma.channel.upsert({ where: { name }, create: { name, sortOrder: i }, update: {} });
  for (const name of WORKSTREAMS) await prisma.workstream.upsert({ where: { name }, create: { name }, update: {} });
  const sla = [
    { id: "SLA-P0", name: "P0 urgent", description: "P0 work: same/next-day completion target, revenue blockers.", rank: 10, rules: { matchPriorities: [0], completionDays: 1, calendar: "CALENDAR" } },
    { id: "SLA-P1P2", name: "High priority", description: "P1–P2: 3 calendar-day target.", rank: 20, rules: { matchPriorities: [1, 2], completionDays: 3, calendar: "CALENDAR" } },
    { id: "SLA-STD", name: "Standard", description: "Default policy; the creator sets the deadline.", rank: 999, rules: { calendar: "CALENDAR" } },
  ];
  for (const p of sla) await prisma.slaPolicy.upsert({ where: { id: p.id }, create: p, update: {} });
  await prisma.scorePolicy.upsert({
    where: { version: 1 },
    create: { version: 1, config: DEFAULT_POLICY, effectiveFrom: "2000-01", note: "Initial interpretation of Delivery 40/20, Dependencies 25, Discipline 15 (DEC-021, DEC-026).", createdById: "system" },
    update: {},
  });
}

const domain = () => process.env.SEED_EMAIL_DOMAIN ?? "example.com";

// Team from the master spec. Escalation owners: L1 Ritesh, L2 Harsh, L3 Dilip (brief §7).
// Roles: Harsh = Admin, Dilip = Leadership (master-spec RBAC; confirm before go-live).
export const TEAM: { name: string; code: string; role: string; level: "L1" | "L2" | "L3" | null; local: string }[] = [
  { name: "Harsh", code: "HSH", role: "admin", level: "L2", local: "harsh" },
  { name: "Dilip Sir", code: "DLP", role: "leadership", level: "L3", local: "dilip" },
  { name: "Ritesh", code: "RIT", role: "member", level: "L1", local: "ritesh" },
  { name: "Pragati", code: "PRG", role: "member", level: null, local: "pragati" },
  { name: "Pratham", code: "PRT", role: "member", level: null, local: "pratham" },
  { name: "Riya", code: "RIY", role: "member", level: null, local: "riya" },
  { name: "Suraj", code: "SUR", role: "member", level: null, local: "suraj" },
  { name: "Yogesh", code: "YOG", role: "member", level: null, local: "yogesh" },
];

export async function seedTeam(prisma: PrismaClient, password: string | null) {
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  for (const u of TEAM) {
    await prisma.user.upsert({
      where: { code: u.code },
      create: { name: u.name, code: u.code, email: `${u.local}@${domain()}`, roleId: roles[u.role], escalationLevel: u.level, passwordHash, title: u.level ? `${u.level} escalation owner` : "" },
      update: {},
    });
  }
}

export async function seedPocs(prisma: PrismaClient) {
  const pocs: [string, "I" | "WB" | "E", string][] = [
    ["Amazon Seller Support", "E", "Amazon"], ["Blinkit Catalog Team", "E", "Blinkit"], ["Myntra Partner Desk", "E", "Myntra"],
    ["Brand Design Team", "WB", "Palmonas"], ["Brand Merchandising", "WB", "Palmonas"],
    ["Finance (Accounts)", "I", "Palmonas"], ["Warehouse Ops", "I", "Palmonas"],
  ];
  for (const [name, type, organisation] of pocs)
    if (!(await prisma.poc.findFirst({ where: { name, type, isRegistry: true } })))
      await prisma.poc.create({ data: { name, type, organisation, isRegistry: true, verifiedNotDuplicate: true, promotedAt: new Date() } });
}
