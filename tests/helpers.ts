import bcrypt from "bcryptjs";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { allocateUserCode, loadActor, type Actor } from "@/domain/actor";
import type { DomainError } from "@/lib/errors";

export async function mkUser(roleKey: string, email = `${roleKey}-${Math.random().toString(36).slice(2, 7)}@example.com`, name = `${roleKey} user`): Promise<Actor> {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const u = await prisma.user.create({ data: { email, name, code: await allocateUserCode(prisma, name), roleId: role.id, passwordHash: await bcrypt.hash("Password123", 4) } });
  return (await loadActor(u.id))!;
}

export const roleId = async (key: string) => (await prisma.role.findUniqueOrThrow({ where: { key } })).id;

export async function expectError(p: Promise<unknown>, code: DomainError["code"], field?: string) {
  try {
    await p;
  } catch (e) {
    const err = e as DomainError;
    expect(err.code, err.message).toBe(code);
    if (field) expect(err.fields?.[field], JSON.stringify(err.fields)).toBeTruthy();
    return err;
  }
  throw new Error(`Expected ${code} but the call succeeded`);
}
