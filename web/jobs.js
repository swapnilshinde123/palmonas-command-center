// Recurring occurrences are created by the server on a timer, so they don't depend on someone opening the page.
// IDs match the page's own generator, so the two never create the same occurrence twice.
import { istToday } from "./policy.js";

const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const fmtD = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function nextOcc(s, from) {
  if (s.cadence === "FLEXI") return s.nextDate || from;
  if (s.cadence === "DAILY") return from;
  const d = new Date(from + "T00:00:00Z");
  if (s.cadence === "WEEKLY") return addDays(from, ((+s.weekday) - d.getUTCDay() + 7) % 7);
  const mk = (y, m) => { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(+s.dayOfMonth || 1, last))).toISOString().slice(0, 10); };
  const c = mk(d.getUTCFullYear(), d.getUTCMonth()); return c >= from ? c : mk(d.getUTCFullYear(), d.getUTCMonth() + 1);
}
const ACTIVE = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "FOR_REVIEW"];

export async function runRecurring(store, log, broadcast) {
  const today = istToday(), now = Date.now();
  const tasks = await store.list("tasks"), ids = new Set(tasks.map((t) => t.id));
  let made = 0;
  for (const { id: sid, data: s } of await store.list("recurring")) {
    if (s.status !== "ACTIVE" || !s.nextDate || s.nextDate > today) continue;
    let occ = s.nextDate, last = null;
    if (s.cadence === "FLEXI") {
      if (tasks.some((t) => t.data.seriesId === sid && !t.data.deleted && ACTIVE.includes(t.data.status))) continue;
      last = occ; occ = null;
    } else while (occ <= today) { last = occ; occ = nextOcc(s, addDays(occ, 1)); }
    const id = `REC-${sid.replace(/^rec-/, "").slice(0, 4).toUpperCase()}-${last.replace(/-/g, "").slice(2)}`;
    if (!ids.has(id)) {
      const dl = addDays(last, +s.leadDays || 0);
      await store.put("tasks", id, { id, name: `${s.title} (${fmtD(last)})`, channel: s.channel, ownerId: s.ownerId, createdBy: s.createdBy || s.ownerId, priority: +s.priority, status: "NOT_STARTED", deadline: dl, originalDeadline: dl, followup: null, description: s.description || "", pocType: null, pocName: null, pendingSince: null, flagged: false, starredBy: [], deleted: false, access: [], extensions: [], waivers: [], transfers: [], removals: [], projectId: s.projectId || null, seriesId: sid, occurrenceDate: last, createdAt: now, updatedAt: now, updatedBy: "system", version: 1, history: [{ at: now, by: s.createdBy || s.ownerId, text: `created from the recurring series "${s.title}"` }] });
      made++;
    }
    await store.put("recurring", sid, { ...s, nextDate: occ, lastGenerated: last });
  }
  if (made) { log("info", "recurring occurrences created", { count: made }); broadcast("tasks"); broadcast("recurring"); }
}
