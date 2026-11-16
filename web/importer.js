// Bulk task import from an uploaded Excel/CSV (rows parsed in the page) or a link-shared Google Sheet (CSV export).
// Each row becomes one task; a row is never imported twice (Row ID, or a fingerprint of name + owner + deadline).
import { createHash, randomBytes } from "node:crypto";
import { istToday } from "./policy.js";

export const COLUMNS = [
  ["rowId", "Row ID", false, "Optional. Any unique value per row (e.g. 1, 2, 3). Stops a row being imported twice."],
  ["name", "Task name", true, "At least 3 characters."],
  ["channel", "Channel", true, "One of the workspace channels."],
  ["owner", "Owner email", true, "Work email of a team member (or their exact name)."],
  ["priority", "Priority", true, "P0 to P5 (P0 is the most urgent)."],
  ["deadline", "Deadline", true, "Date as YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY."],
  ["followup", "Follow-up date", false, "Same date formats. Optional."],
  ["project", "Project", false, "Exact project name. Optional."],
  ["description", "Description", false, "Optional."],
  ["pocType", "Pending From type", false, "Internal, Within Brand or External. Optional."],
  ["pocName", "Pending From name", false, "Internal: team member email or name. Others: POC name."],
  ["outputLink", "Output link", false, "Optional https:// link."],
];
const ALIASES = { "row id": "rowId", "id": "rowId", "task": "name", "task name": "name", "name": "name", "channel": "channel", "owner": "owner", "owner email": "owner", "assignee": "owner", "priority": "priority", "deadline": "deadline", "due date": "deadline", "follow-up": "followup", "follow-up date": "followup", "followup": "followup", "project": "project", "description": "description", "notes": "description", "pending from type": "pocType", "poc type": "pocType", "pending from name": "pocName", "poc name": "pocName", "pending from": "pocName", "output link": "outputLink", "link": "outputLink" };
const POC = { internal: "I", i: "I", "within brand": "WB", wb: "WB", brand: "WB", external: "E", e: "E" };
const MAX_ROWS = 1000;

export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head = [], ...body] = rows;
  return body.filter((r) => r.some((v) => String(v).trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

function normRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) { const key = ALIASES[String(k).trim().toLowerCase().replace(/\s*\*$/, "")]; if (key && out[key] === undefined) out[key] = typeof v === "string" ? v.trim() : v; }
  return out;
}
function parseDate(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); if (m) return iso(+m[3], +m[2], +m[1]);
  const d = new Date(s); return isNaN(d) ? undefined : d.toISOString().slice(0, 10);
}
function iso(y, mo, d) { const t = new Date(Date.UTC(y, mo - 1, d)); return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : undefined; }

// Checks every row; with commit=true creates the valid ones. Returns one result per row.
export async function importRows(store, { rows, me, source, commit, onCreated }) {
  if (!Array.isArray(rows)) throw Object.assign(new Error("No rows to import."), { status: 400 });
  if (rows.length > MAX_ROWS) throw Object.assign(new Error(`Up to ${MAX_ROWS} rows at a time.`), { status: 400 });
  const [team, cfg, projects, tasks] = await Promise.all(["team", "config", "projects", "tasks"].map((c) => store.list(c)));
  const main = cfg.find((c) => c.id === "main")?.data || {};
  const channels = main.channels || [];
  const members = team.filter((m) => !m.data.removed && !m.data.linkedTo);
  const findMember = (v) => { const s = String(v || "").trim().toLowerCase(); if (!s) return null; return members.find((m) => String(m.data.email || "").toLowerCase() === s) || members.find((m) => String(m.data.alias || m.data.displayName || "").toLowerCase() === s) || null; };
  const seen = new Set(tasks.map((t) => t.data.importKey).filter(Boolean));
  const today = istToday(), now = Date.now(), results = [];
  for (let i = 0; i < rows.length; i++) {
    const r = normRow(rows[i]), errors = [], warnings = [];
    if (!Object.entries(r).some(([k, v]) => k !== "rowId" && String(v ?? "").trim())) continue;
    if (/^example/i.test(String(r.rowId || "").trim())) { results.push({ row: i + 2, name: String(r.name || ""), owner: r.owner || "", deadline: null, errors: [], warnings: ["Example row from the template: skipped."], status: "example" }); continue; }
    const name = String(r.name || "").trim();
    if (name.length < 3) errors.push("Task name needs at least 3 characters.");
    const channel = channels.find((c) => c.toLowerCase() === String(r.channel || "").trim().toLowerCase());
    if (!channel) errors.push(r.channel ? `Unknown channel "${r.channel}".` : "Channel is missing.");
    const owner = findMember(r.owner);
    if (!owner) errors.push(r.owner ? `No team member matches "${r.owner}".` : "Owner email is missing.");
    const pm = String(r.priority ?? "").trim().toUpperCase().match(/^P?([0-5])$/);
    if (!pm) errors.push("Priority must be P0 to P5.");
    const deadline = parseDate(r.deadline);
    if (!deadline) errors.push(deadline === undefined ? `Deadline "${r.deadline}" isn't a date.` : "Deadline is missing.");
    else if (deadline < today) warnings.push("Deadline is already past: it'll show as overdue.");
    const followup = parseDate(r.followup);
    if (followup === undefined) errors.push(`Follow-up "${r.followup}" isn't a date.`);
    let projectId = null;
    if (r.project) { const p = projects.find((x) => String(x.data.name || "").toLowerCase() === String(r.project).toLowerCase()); if (p) projectId = p.id; else warnings.push(`Project "${r.project}" not found: imported without a project.`); }
    let pocType = null, pocName = null, pocMemberId = null;
    if (r.pocType || r.pocName) {
      pocType = POC[String(r.pocType || "").trim().toLowerCase()] || null;
      if (!pocType) errors.push("Pending From type must be Internal, Within Brand or External.");
      else if (pocType === "I") { const m = findMember(r.pocName); if (!m) errors.push(`Pending From: no team member matches "${r.pocName || ""}".`); else { pocMemberId = m.id; pocName = m.data.alias || m.data.displayName; } }
      else if (!String(r.pocName || "").trim()) errors.push("Pending From name is missing.");
      else pocName = String(r.pocName).trim();
    }
    const outputLink = String(r.outputLink || "").trim();
    if (outputLink && !/^https?:\/\/\S+\.\S+/.test(outputLink)) errors.push("Output link must start with https://");
    const key = r.rowId ? `${source}:id:${String(r.rowId).trim()}` : `${source}:fp:` + createHash("sha1").update([name.toLowerCase(), owner?.id, deadline].join("|")).digest("hex").slice(0, 16);
    const dup = seen.has(key);
    const res = { row: i + 2, name, owner: owner ? (owner.data.alias || owner.data.displayName) : r.owner || "", deadline, errors, warnings, status: errors.length ? "error" : dup ? "duplicate" : "ok" };
    if (commit && res.status === "ok") {
      const id = `IMP-${today.replace(/-/g, "").slice(2)}-${randomBytes(3).toString("hex").toUpperCase()}`;
      const task = { id, name, channel, ownerId: owner.id, createdBy: me, priority: +pm[1], status: "NOT_STARTED", deadline, originalDeadline: deadline, followup: followup || null, description: String(r.description || ""), projectId, pocType, pocName, pocMemberId, pendingSince: pocType ? now : null, outputLink: outputLink || null, flagged: false, starredBy: [], deleted: false, access: owner.id === me ? [] : [me], extensions: [], waivers: [], transfers: [], removals: [], importKey: key, importSource: source, createdAt: now, updatedAt: now, updatedBy: me, version: 1, history: [{ at: now, by: me, text: `imported the task from ${source === "sheet" ? "the connected Google Sheet" : "an Excel/CSV upload"} (row ${i + 2})${owner.id !== me ? ` and assigned it to ${owner.data.alias || owner.data.displayName}` : ""}` }] };
      await store.put("tasks", id, task);
      seen.add(key); res.status = "created"; res.id = id;
      await onCreated?.(task);
    } else if (!commit && res.status === "ok") seen.add(key);
    results.push(res);
  }
  const count = (s) => results.filter((x) => x.status === s).length;
  return { results, summary: { total: results.length, ok: count("ok"), created: count("created"), duplicate: count("duplicate"), error: count("error"), example: count("example") } };
}

const SHEET_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/;
export function sheetCsvUrl(link) {
  const m = String(link || "").trim().match(SHEET_RE);
  if (!m) return null;
  const gid = String(link).match(/[#&?]gid=(\d+)/)?.[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
export async function fetchSheetRows(link) {
  const url = process.env.SHEET_TEST_CSV_URL || sheetCsvUrl(link);
  if (!url) throw new Error("That isn't a Google Sheets link.");
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !/text\/csv|text\/plain|application\/octet-stream/.test(type)) throw new Error("Couldn't read the sheet. Share it as \"Anyone with the link can view\" and check the link points to the Tasks tab.");
  const text = await r.text();
  if (text.length > 5_000_000) throw new Error("The sheet is too large.");
  return parseCsv(text);
}
