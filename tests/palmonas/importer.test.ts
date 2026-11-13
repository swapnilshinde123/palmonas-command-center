import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { importTaskTracker, parseLooseDate } from "@/domain/importer";
import { kpis } from "@/domain/metrics";
import { iso } from "@/lib/dates";
import { actors } from "./helpers";

const csv = readFileSync(new URL("./fixtures/task-tracker-sample.csv", import.meta.url), "utf8");

describe("Task Tracker CSV import (§40, DEC-001)", () => {
  it("parses the date formats found in Sheets exports", () => {
    expect(iso(parseLooseDate("11/11/2026"))).toBe("2026-11-11");
    expect(iso(parseLooseDate("03-Oct-2026"))).toBe("2026-10-03");
    expect(iso(parseLooseDate("46338"))).toBe("2026-11-12");
    expect(() => parseLooseDate("next tuesday")).toThrow();
  });

  it("dry run writes nothing and reports mapping + row errors", async () => {
    const r = await importTaskTracker(csv, { dryRun: true });
    expect(r.headerMapping.metadata).toBe("Metadata");
    expect(r.unmappedHeaders).toEqual(expect.arrayContaining(["Aging (Days)", "Timeliness"]));
    expect(r.totals).toMatchObject({ WOULD_IMPORT: 4, ERROR: 1 });
    expect(r.rows.find((x) => x.status === "ERROR")!.errors![0]).toMatch(/Nobody/);
    expect(await prisma.task.count()).toBe(0);
  });

  it("QA-068/QA-075 commit: keeps legacy IDs, carries state, no notification flood, idempotent re-run", async () => {
    const r = await importTaskTracker(csv, { dryRun: false, file: "fixture.csv" });
    expect(r.totals.IMPORTED).toBe(4);
    const t = await prisma.task.findUniqueOrThrow({ where: { id: "PRG-261111-206" }, include: { subtasks: true, escalations: true, extensions: true } });
    expect(t.legacyId).toBe("PRG-261111-206");
    expect(t.pocType).toBe("I");
    expect(t.subtasks[0]).toMatchObject({ title: "Finance clearance on credit note", depType: "I", pendingFrom: "Nupur", ownerId: null });
    expect(t.escalations[0].level).toBe("L1");
    expect(t.escalationRequired).toBe(true);
    expect(t.extensions[0].status).toBe("PENDING");
    const done = await prisma.task.findUniqueOrThrow({ where: { id: "HSH-261101-001" } });
    expect(done.extensionsCount).toBe(0);
    expect((done.extra as { import: { legacyMetadata: { extensionsCount: number } } }).import.legacyMetadata.extensionsCount).toBe(1);
    const legacy = await prisma.task.findFirstOrThrow({ where: { name: "Old row without metadata" } });
    expect(legacy.id).toMatch(/^DLP-/);
    expect((await prisma.task.findFirstOrThrow({ where: { name: "test - ignore me" } })).excludedFromMetrics).toBe(true);
    expect(await prisma.notificationEvent.count()).toBe(0);
    expect(await prisma.auditEvent.count({ where: { eventType: "TASK_IMPORTED" } })).toBe(4);
    const again = await importTaskTracker(csv, { dryRun: false });
    expect(again.totals.SKIPPED_EXISTING).toBe(4);
    expect(await prisma.task.count()).toBe(4);
    const { harsh } = await actors();
    const k = await kpis(harsh);
    expect(k.completedOnTime + k.completedLate + k.inProgress + k.overdue).toBe(3);
  });
});
