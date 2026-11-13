import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type Tx = Prisma.TransactionClient;

// Serializable would be safer but forces retry loops everywhere; row-level guards
// (version checks, partial unique indexes, FOR UPDATE) give us the invariants we need.
export function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { timeout: 15000, maxWait: 5000 });
}
