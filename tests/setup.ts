import { beforeEach, afterAll, expect } from "vitest";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/palmonas_test";
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.LOG_LEVEL = "error";
process.env.INVITE_RESEND_COOLDOWN_SECONDS = "0";
delete process.env.SMTP_HOST;

const { prisma } = await import("@/lib/db");
const { seedBaseline, seedTeam, seedPocs } = await import("../prisma/seed-data");

beforeEach(async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await seedBaseline(prisma);
  // Account-admin suites start with no users; task-workspace suites get the Palmonas team.
  if (!/tests\/(invitations|users-roles)\.test/.test(expect.getState().testPath ?? "")) {
    await seedTeam(prisma, null);
    await seedPocs(prisma);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
