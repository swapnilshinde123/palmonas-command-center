import { prisma } from "@/lib/db";
import { loadActor, type Actor } from "@/domain/actor";
import { createTask, type CreateTaskInput } from "@/domain/tasks";
import { addDays, iso, parseISODate, todayBiz } from "@/lib/dates";
import type { DomainError } from "@/lib/errors";
import { expect } from "vitest";

export async function actors() {
  const users = await prisma.user.findMany();
  const by = async (code: string): Promise<Actor> => (await loadActor(users.find((x) => x.code === code)!.id))!;
  return { harsh: await by("HSH"), dilip: await by("DLP"), pragati: await by("PRG"), pratham: await by("PRT"), ritesh: await by("RIT"), riya: await by("RIY"), suraj: await by("SUR"), yogesh: await by("YOG") };
}

export async function channel(name = "Amazon") {
  return (await prisma.channel.findUniqueOrThrow({ where: { name } })).id;
}

export const today = () => todayBiz();
export const day = (offset: number) => iso(addDays(todayBiz(), offset))!;

export async function mkTask(actor: Actor, over: Partial<CreateTaskInput> = {}) {
  const { result } = await createTask(actor, { name: "Fix Amazon catalog images", channelId: await channel(), ownerId: actor.id, priority: 3, deadline: day(3), ...over });
  return result.task;
}

export async function backdate(id: string, d: { assignedDate?: string; deadline?: string; completedAt?: Date }) {
  await prisma.task.update({
    where: { id },
    data: {
      ...(d.assignedDate ? { assignedDate: parseISODate(d.assignedDate) } : {}),
      ...(d.deadline ? { deadline: parseISODate(d.deadline), originalDeadline: parseISODate(d.deadline) } : {}),
      ...(d.completedAt ? { completedAt: d.completedAt } : {}),
    },
  });
}

export const version = async (id: string) => (await prisma.task.findUniqueOrThrow({ where: { id } })).version;

export async function expectError(p: Promise<unknown>, code: DomainError["code"], field?: string) {
  try {
    await p;
  } catch (e) {
    const err = e as DomainError;
    expect(err.code, err.message).toBe(code);
    if (field) expect(err.fields?.[field], JSON.stringify(err.fields)).toBeTruthy();
    return err;
  }
  throw new Error(`Expected ${code} error but call succeeded`);
}

// Email delivery is OFF by default (approval gate); delivery tests switch it on explicitly.
export async function emailOn(extra: Record<string, unknown> = {}) {
  await prisma.appConfig.upsert({ where: { key: "notifications" }, create: { key: "notifications", value: { emailDelivery: "ON", ...extra } }, update: { value: { emailDelivery: "ON", ...extra } } });
}
