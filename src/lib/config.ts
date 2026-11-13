import { prisma, type Tx } from "./db";

// Operational policy knobs. Defaults implement docs/DECISIONS.md; admins can override via /admin.
export const CONFIG_DEFAULTS = {
  // Brief §5: Due Soon / Follow-up Soon windows (days ahead, inclusive). Proposed defaults, awaiting approval.
  dueSoon: { deadlineDays: 3, followupDays: 2 },
  // DEC-025: case-insensitive, after trim, prefix followed by a separator or end of string.
  exclusionGate: { pattern: "^(qa|test)([\\s\\-_:.#]|$)" },
  // DEC-043
  // emailDelivery OFF until the notification matrix is approved (brief Addendum A, implementation gate).
  notifications: { emailDelivery: "OFF" as "OFF" | "ON", digestsEnabled: false, maxAttempts: 5, backoffMinutes: [5, 15, 60, 180], claimTimeoutMinutes: 10, digestTime: "09:00", sendEmptyPersonalDigest: false },
  // DEC-038: parent completion requires required subtasks complete; ADMIN/LEADERSHIP may override with reason.
  subtasks: { requireCompleteForParent: true, autoCompleteParent: false },
  // DEC-032: project completion blocked while eligible linked tasks are active, unless override with reason.
  projects: { allowCompleteWithOpenTasks: "WITH_OVERRIDE" as "NEVER" | "WITH_OVERRIDE" },
  // §9.2: same-day deadlines allowed; deadline < assigned date rejected.
  deadlines: { allowSameDay: true, allowBeforeAssigned: false },
  // §13.3 retention; null = keep indefinitely (no auto-purge is ever run).
  retention: { auditDays: null as number | null, deletedTaskDays: null as number | null },
  // DEC-012: owner-only workload attribution.
  workload: { countSubtaskOwners: false },
  descriptionMaxLength: 5000,
};

export type AppConfigShape = typeof CONFIG_DEFAULTS;
type Key = keyof AppConfigShape;

export async function getConfig<K extends Key>(key: K, db: Tx | typeof prisma = prisma): Promise<AppConfigShape[K]> {
  const row = await db.appConfig.findUnique({ where: { key } });
  if (!row) return CONFIG_DEFAULTS[key];
  const def = CONFIG_DEFAULTS[key];
  return (typeof def === "object" && def !== null ? { ...def, ...(row.value as object) } : row.value) as AppConfigShape[K];
}

export async function getAllConfig(): Promise<AppConfigShape> {
  const rows = await prisma.appConfig.findMany();
  const out: Record<string, unknown> = structuredClone(CONFIG_DEFAULTS);
  for (const r of rows) {
    const def = (CONFIG_DEFAULTS as Record<string, unknown>)[r.key];
    if (def === undefined) continue;
    out[r.key] = typeof def === "object" && def !== null ? { ...(def as object), ...(r.value as object) } : r.value;
  }
  return out as AppConfigShape;
}

export async function getHolidays(db: Tx | typeof prisma = prisma): Promise<Set<string>> {
  const rows = await db.holiday.findMany({ select: { date: true } });
  return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
}

export function exclusionMatcher(pattern: string) {
  const re = new RegExp(pattern, "i");
  return (name: string) => re.test(name.trim());
}
