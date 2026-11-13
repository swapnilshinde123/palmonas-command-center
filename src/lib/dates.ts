// Business dates are stored as Postgres DATE, which Prisma maps to a JS Date at 00:00 UTC.
// All "today" logic is evaluated in the business timezone (DEC-006: Asia/Kolkata).
export const BUSINESS_TZ = process.env.BUSINESS_TZ ?? "Asia/Kolkata";
const DAY = 86_400_000;

const isoFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export function businessDateOf(instant: Date): Date {
  return parseISODate(isoFmt.format(instant));
}

export function todayBiz(now: Date = new Date()): Date {
  return businessDateOf(now);
}

export function businessHHMM(now: Date = new Date()): string {
  return hourFmt.format(now);
}

export function parseISODate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date: ${s}`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function tryParseISODate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  try {
    return parseISODate(s);
  } catch {
    return null;
  }
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const diffDays = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
export const weekday = (d: Date) => d.getUTCDay(); // 0=Sun

export function daysInMonth(year: number, month0: number) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export function isWorkingDay(d: Date, holidays: Set<string>) {
  const w = weekday(d);
  return w !== 0 && w !== 6 && !holidays.has(iso(d)!);
}

export function addWorkingDays(d: Date, n: number, holidays: Set<string>) {
  let cur = d;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (isWorkingDay(cur, holidays)) left--;
  }
  return cur;
}

export function monthBounds(month: string) {
  const start = parseISODate(`${month}-01`);
  const [y, m] = month.split("-").map(Number);
  const end = addDays(start, daysInMonth(y, m - 1));
  return { start, end }; // [start, end)
}
