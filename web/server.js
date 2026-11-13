// Palmonas Command Center: standalone server for the single-page app in public/index.html.
// Stores documents in Postgres (DATABASE_URL) or, without it, in a local JSON file for development.
// Sign-in is per person with a PIN, checked here; a first PIN needs the workspace SETUP_CODE.
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scrypt = promisify(scryptCb);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SETUP_CODE = process.env.SETUP_CODE || "";
const DB_URL = process.env.DATABASE_URL || "";
const SESSION_DAYS = 30;
// Google sign-in: the OAuth client ID is public; ADMIN_EMAIL is made an Admin and the workspace owner on start.
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
// With Google configured, PIN sign-in is off unless PIN_LOGIN=true.
const PIN_LOGIN = process.env.PIN_LOGIN ? process.env.PIN_LOGIN === "true" : !GOOGLE_CLIENT_ID;
const TOKENINFO_URL = process.env.GOOGLE_TOKENINFO_URL || "https://oauth2.googleapis.com/tokeninfo";
let PUBLIC_COLS = new Set(["team", "roles", "config", "pins"]);
const ALL_COLS = new Set(["tasks", "team", "roles", "config", "projects", "recurring", "kpi", "invitations", "pins"]);
const ADMIN_COLS = new Set(["roles", "config", "invitations", "kpi"]);
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

if (!SETUP_CODE) log("warn", "SETUP_CODE is not set: nobody can create a first PIN until it is");

// ---------- storage ----------
let store;
async function pgStore() {
  const { default: pg } = await import("pg");
  const ssl = /sslmode=require|\.render\.com|neon\.tech/.test(DB_URL) ? { rejectUnauthorized: false } : false;
  const pool = new pg.Pool({ connectionString: DB_URL, ssl, max: 5 });
  await pool.query(`CREATE TABLE IF NOT EXISTS docs (col text NOT NULL, id text NOT NULL, data jsonb NOT NULL, version int NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (col, id));
    CREATE TABLE IF NOT EXISTS pins (user_id text PRIMARY KEY, hash text NOT NULL, salt text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);`);
  return {
    async list(col) { return (await pool.query("SELECT id, data, version FROM docs WHERE col=$1", [col])).rows; },
    async get(col, id) { return (await pool.query("SELECT id, data, version FROM docs WHERE col=$1 AND id=$2", [col, id])).rows[0] || null; },
    async put(col, id, data) { await pool.query("INSERT INTO docs (col,id,data) VALUES ($1,$2,$3) ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, version=docs.version+1, updated_at=now()", [col, id, data]); },
    async del(col, id) { await pool.query("DELETE FROM docs WHERE col=$1 AND id=$2", [col, id]); },
    async count() { return Number((await pool.query("SELECT count(*) FROM docs")).rows[0].count); },
    async pinGet(u) { return (await pool.query("SELECT hash, salt FROM pins WHERE user_id=$1", [u])).rows[0] || null; },
    async pinSet(u, hash, salt) { await pool.query("INSERT INTO pins (user_id,hash,salt) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET hash=EXCLUDED.hash, salt=EXCLUDED.salt, created_at=now()", [u, hash, salt]); },
    async pinDel(u) { await pool.query("DELETE FROM pins WHERE user_id=$1", [u]); await pool.query("DELETE FROM sessions WHERE user_id=$1", [u]); },
    async pinIds() { return (await pool.query("SELECT user_id FROM pins")).rows.map((r) => r.user_id); },
    async sessNew(th, u, exp) { await pool.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [th, u, exp]); },
    async sessGet(th) { return (await pool.query("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()", [th])).rows[0]?.user_id || null; },
    async sessDel(th) { await pool.query("DELETE FROM sessions WHERE token_hash=$1", [th]); },
  };
}
async function fileStore() {
  const file = path.join(DIR, ".data", "store.json");
  await mkdir(path.dirname(file), { recursive: true });
  const s = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : { docs: {}, pins: {}, sessions: {} };
  let t; const save = () => { clearTimeout(t); t = setTimeout(() => writeFile(file, JSON.stringify(s)).catch(() => {}), 100); };
  const k = (c, i) => c + "/" + i;
  return {
    async list(col) { return Object.entries(s.docs).filter(([key]) => key.startsWith(col + "/")).map(([key, v]) => ({ id: key.slice(col.length + 1), ...v })); },
    async get(col, id) { const v = s.docs[k(col, id)]; return v ? { id, ...v } : null; },
    async put(col, id, data) { const v = s.docs[k(col, id)]; s.docs[k(col, id)] = { data, version: (v?.version || 0) + 1 }; save(); },
    async del(col, id) { delete s.docs[k(col, id)]; save(); },
    async count() { return Object.keys(s.docs).length; },
    async pinGet(u) { return s.pins[u] || null; },
    async pinSet(u, hash, salt) { s.pins[u] = { hash, salt }; save(); },
    async pinDel(u) { delete s.pins[u]; for (const [th, v] of Object.entries(s.sessions)) if (v.u === u) delete s.sessions[th]; save(); },
    async pinIds() { return Object.keys(s.pins); },
    async sessNew(th, u, exp) { s.sessions[th] = { u, exp: exp.getTime() }; save(); },
    async sessGet(th) { const v = s.sessions[th]; return v && v.exp > Date.now() ? v.u : null; },
    async sessDel(th) { delete s.sessions[th]; save(); },
  };
}
async function seedIfEmpty() {
  if ((await store.count()) > 0) return;
  const file = path.join(DIR, "seed", "initial-data.json");
  if (!existsSync(file)) return;
  const data = JSON.parse(await readFile(file, "utf8"));
  let n = 0;
  for (const [col, docs] of Object.entries(data)) for (const [id, doc] of Object.entries(docs)) { if (ALL_COLS.has(col) && col !== "pins") { await store.put(col, id, doc); n++; } }
  log("info", "loaded initial data", { documents: n });
}

// ---------- auth ----------
async function verifyGoogle(credential) {
  if (!GOOGLE_CLIENT_ID || typeof credential !== "string" || credential.length > 5000) return null;
  const r = await fetch(`${TOKENINFO_URL}?id_token=${encodeURIComponent(credential)}`);
  if (!r.ok) return null;
  const t = await r.json();
  const issOk = t.iss === "accounts.google.com" || t.iss === "https://accounts.google.com";
  const verified = t.email_verified === true || t.email_verified === "true";
  if (t.aud !== GOOGLE_CLIENT_ID || !issOk || !verified || Number(t.exp) * 1000 < Date.now() || !t.email) return null;
  return { email: String(t.email).toLowerCase(), name: t.name || "" };
}
async function memberByEmail(email) {
  return (await store.list("team")).find((m) => !m.data.removed && !m.data.linkedTo && String(m.data.email || "").toLowerCase() === email) || null;
}
// One-time wipe: set RESET_KEY to a new value and redeploy. Keeps only the ADMIN_EMAIL person and workspace settings.
async function resetIfRequested() {
  const key = (process.env.RESET_KEY || "").trim();
  if (!key) return;
  if ((await store.get("config", "reset"))?.data?.key === key) return;
  if (!ADMIN_EMAIL) { log("warn", "RESET_KEY ignored: ADMIN_EMAIL is not set"); return; }
  const keep = await memberByEmail(ADMIN_EMAIL);
  let n = 0;
  for (const col of ["tasks", "projects", "recurring", "kpi", "invitations"]) for (const d of await store.list(col)) { await store.del(col, d.id); n++; }
  for (const d of await store.list("team")) if (d.id !== keep?.id) { await store.del("team", d.id); n++; }
  for (const d of await store.list("roles")) if (d.id !== keep?.id) { await store.del("roles", d.id); n++; }
  for (const u of await store.pinIds()) if (u !== keep?.id) await store.pinDel(u);
  const main = (await store.get("config", "main"))?.data || {};
  await store.put("config", "main", { ...main, levels: {}, roleDefaults: main.roleDefaults || {} });
  await store.put("config", "reset", { key, at: Date.now() });
  log("info", "workspace reset", { deleted: n, kept: keep?.id || null });
}
async function ensureAdminEmail() {
  if (!ADMIN_EMAIL) return;
  let m = await memberByEmail(ADMIN_EMAIL);
  if (!m) {
    const local = ADMIN_EMAIL.split("@")[0].split(/[._+-]/)[0];
    m = (await store.list("team")).find((x) => !x.data.removed && !x.data.linkedTo && !x.data.email && String(x.data.alias || x.data.displayName || "").toLowerCase().split(/\s+/)[0] === local) || null;
    if (m) await store.put("team", m.id, { ...m.data, email: ADMIN_EMAIL });
    else { const id = "p_" + local.replace(/[^a-z0-9]/g, "") + "-admin"; m = { id, data: { id, displayName: local.charAt(0).toUpperCase() + local.slice(1), email: ADMIN_EMAIL, placeholder: true, joinedAt: Date.now() } }; await store.put("team", id, m.data); }
  }
  const role = (await store.get("roles", m.id))?.data;
  if (role?.role !== "admin") await store.put("roles", m.id, { ...(role || {}), role: "admin", by: "system", at: Date.now() });
  const prevOwner = (await store.get("config", "owner"))?.data?.ownerId;
  if (prevOwner !== m.id) {
    // The previous owner keeps Admin rights through an explicit role.
    if (prevOwner && !(await store.get("roles", prevOwner))) await store.put("roles", prevOwner, { role: "admin", by: "system", at: Date.now() });
    await store.put("config", "owner", { ownerId: m.id });
  }
  log("info", "admin email ready", { userId: m.id });
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hashPin = async (pin, salt) => (await scrypt(pin, salt, 32)).toString("hex");
const fails = new Map(); // userId -> { n, until }
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])); }
async function sessionUser(req) { const tok = parseCookies(req).pcc_session; return tok ? store.sessGet(sha(tok)) : null; }
const cookie = (req, value, maxAge) => `pcc_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;
async function isAdminUser(u) {
  if (!u) return false;
  const owner = (await store.get("config", "owner"))?.data?.ownerId;
  if (u === owner) return true;
  const r = (await store.get("roles", u))?.data;
  if (r?.role === "admin" && r?.perms?.users_manage !== false) return true;
  return !!(r?.perms && (r.perms.users_manage || r.perms.roles_manage || r.perms.settings_manage || r.perms.kpi_close));
}

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function broadcast(col) { const msg = `data: ${JSON.stringify({ col })}\n\n`; for (const c of clients) if (c.authed || PUBLIC_COLS.has(col)) c.res.write(msg); }
setInterval(() => { for (const c of clients) c.res.write(": ping\n\n"); }, 25000).unref();

// ---------- http ----------
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC_HEADERS, ...headers }); res.end(JSON.stringify(body)); };
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1_000_000) throw Object.assign(new Error("Too large"), { status: 413 }); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
const publicView = (col, rows) => col === "team" ? rows.map((r) => ({ ...r, data: { ...r.data, email: undefined } })) : rows;
let indexHtml = "";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && (p === "/" || p === "/index.html")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...SEC_HEADERS }); return res.end(indexHtml); }
    if (!p.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    // Writes need a custom header, which cross-site forms can't send.
    if (req.method !== "GET" && req.headers["x-pcc"] !== "1") return send(res, 403, { error: "Missing request header" });
    const me = await sessionUser(req);

    if (p === "/api/me") return send(res, 200, { userId: me });
    if (p === "/api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      const c = { res, authed: !!me }; clients.add(c); req.on("close", () => clients.delete(c)); return;
    }
    if (p === "/api/login" && req.method === "POST") {
      if (!PIN_LOGIN) return send(res, 403, { error: "PIN sign-in is turned off. Use Google." });
      const { userId, pin, setupCode } = await body(req);
      if (!SEG.test(String(userId || "")) || !/^\d{4,6}$/.test(String(pin || ""))) return send(res, 400, { error: "Enter 4 to 6 digits." });
      const member = await store.get("team", userId);
      if (!member || member.data.removed) return send(res, 404, { error: "This person isn't on the team." });
      const f = fails.get(userId);
      if (f?.until > Date.now()) return send(res, 423, { error: `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} seconds.` });
      const rec = await store.pinGet(userId);
      if (rec) {
        const ok = timingSafeEqual(Buffer.from(await hashPin(pin, rec.salt), "hex"), Buffer.from(rec.hash, "hex"));
        if (!ok) { const n = (f?.n || 0) + 1; fails.set(userId, n >= 5 ? { n: 0, until: Date.now() + 60000 } : { n }); return send(res, 401, { error: n >= 5 ? "Too many attempts. Try again in 60 seconds." : `Wrong PIN. ${5 - n} attempt${5 - n === 1 ? "" : "s"} left.` }); }
      } else {
        const given = Buffer.from(String(setupCode || "")), want = Buffer.from(SETUP_CODE);
        if (!SETUP_CODE || given.length !== want.length || !timingSafeEqual(given, want)) { const n = (f?.n || 0) + 1; fails.set(userId, n >= 5 ? { n: 0, until: Date.now() + 60000 } : { n }); return send(res, 403, { error: "That setup code isn't right. Ask your Admin for the workspace setup code." }); }
        const salt = randomBytes(16).toString("hex");
        await store.pinSet(userId, await hashPin(pin, salt), salt);
        broadcast("pins");
        log("info", "pin created", { userId });
      }
      fails.delete(userId);
      const tok = randomBytes(32).toString("base64url");
      await store.sessNew(sha(tok), userId, new Date(Date.now() + SESSION_DAYS * 864e5));
      log("info", "signed in", { userId });
      return send(res, 200, { userId }, { "Set-Cookie": cookie(req, tok, SESSION_DAYS * 86400) });
    }
    if (p === "/api/login/google" && req.method === "POST") {
      if (!GOOGLE_CLIENT_ID) return send(res, 404, { error: "Google sign-in isn't set up." });
      const { credential } = await body(req);
      const g = await verifyGoogle(credential);
      if (!g) return send(res, 401, { error: "Google sign-in didn't go through. Try again." });
      const m = await memberByEmail(g.email);
      if (!m) { log("warn", "google sign-in for unknown email", { email: g.email }); return send(res, 403, { error: `${g.email} isn't on the team yet. Ask an Admin to add this email in User management.` }); }
      const tok = randomBytes(32).toString("base64url");
      await store.sessNew(sha(tok), m.id, new Date(Date.now() + SESSION_DAYS * 864e5));
      log("info", "signed in with google", { userId: m.id });
      return send(res, 200, { userId: m.id }, { "Set-Cookie": cookie(req, tok, SESSION_DAYS * 86400) });
    }
    if (p === "/api/logout" && req.method === "POST") {
      const tok = parseCookies(req).pcc_session; if (tok) await store.sessDel(sha(tok));
      return send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0) });
    }

    const m = p.match(/^\/api\/(col|doc)\/([^/]+)(?:\/([^/]+))?$/);
    if (!m) return send(res, 404, { error: "Not found" });
    const [, kind, col, id] = m;
    if (!ALL_COLS.has(col) || (id && !SEG.test(id))) return send(res, 400, { error: "Unknown collection" });
    if (col === "pins") {
      if (req.method === "GET") return send(res, 200, { docs: (await store.pinIds()).map((u) => ({ id: u, data: { hasPin: true }, version: 1 })) });
      if (req.method === "DELETE" && id) { if (!(await isAdminUser(me))) return send(res, 403, { error: "Only an Admin can reset a PIN." }); await store.pinDel(id); broadcast("pins"); log("info", "pin reset", { userId: id, by: me }); return send(res, 200, { ok: true }); }
      return send(res, 403, { error: "PINs are set at sign-in." });
    }
    if (kind === "col" && req.method === "GET") {
      if (!me && !PUBLIC_COLS.has(col)) return send(res, 200, { docs: [], signedOut: true });
      const rows = await store.list(col);
      return send(res, 200, { docs: me ? rows : publicView(col, rows) });
    }
    if (kind === "doc" && id) {
      if (!me) return send(res, 401, { error: "Sign in first." });
      if (req.method === "GET") return send(res, 200, { doc: await store.get(col, id) });
      const adminNeeded = ADMIN_COLS.has(col) || (col === "team" && id !== me);
      if (adminNeeded && !(await isAdminUser(me))) return send(res, 403, { error: "Only an Admin can change this." });
      if (req.method === "PUT") { const { data } = await body(req); if (!data || typeof data !== "object") return send(res, 400, { error: "Missing data" }); await store.put(col, id, data); broadcast(col); return send(res, 200, { ok: true }); }
      if (req.method === "DELETE") { await store.del(col, id); broadcast(col); return send(res, 200, { ok: true }); }
    }
    return send(res, 405, { error: "Method not allowed" });
  } catch (e) {
    log("error", "request failed", { path: p, error: e.message });
    return send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the server." });
  }
});

(async () => {
  // Without PIN sign-in nobody needs the team list before signing in, so keep it private.
  if (!PIN_LOGIN) PUBLIC_COLS = new Set(["config"]);
  store = DB_URL ? await pgStore() : await fileStore();
  await seedIfEmpty();
  await resetIfRequested();
  await ensureAdminEmail();
  indexHtml = (await readFile(path.join(DIR, "public", "index.html"), "utf8")).replace("<script>", `<script>window.__PCC_GOOGLE_CLIENT_ID=${JSON.stringify(GOOGLE_CLIENT_ID)};window.__PCC_PIN_LOGIN=${PIN_LOGIN};</script><script>`);
  server.listen(PORT, () => log("info", "listening", { port: PORT, storage: DB_URL ? "postgres" : "file", google: !!GOOGLE_CLIENT_ID, pinLogin: PIN_LOGIN }));
})().catch((e) => { log("error", "startup failed", { error: e.message }); process.exit(1); });
