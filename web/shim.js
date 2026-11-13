// Replaces claude.ai's window.claude runtime with this app's own server API.
window.__PCC_STANDALONE = true;
(function () {
  const H = { "Content-Type": "application/json", "X-PCC": "1" };
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: H, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && method !== "GET" && window.__pccOnExpired) window.__pccOnExpired();
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
    return j;
  }
  const subs = {}, cache = {};
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const snap = (col) => ({ docs: (cache[col] || []).map((d) => ({ id: d.id, data: () => clone(d.data) })) });
  async function refresh(col) {
    try { cache[col] = (await api("GET", "/api/col/" + col)).docs; for (const s of subs[col] || []) s.cb(snap(col)); }
    catch (e) { if (e.status === 401) { cache[col] = []; for (const s of subs[col] || []) s.cb(snap(col)); } else for (const s of subs[col] || []) s.err && s.err(e); }
  }
  const refreshAll = () => Object.keys(subs).forEach(refresh);
  let es;
  function stream() {
    if (es) es.close();
    es = new EventSource("/api/stream");
    es.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "hello") refreshAll(); else if (m.col && subs[m.col]) refresh(m.col); };
  }
  const db = {
    doc(path) {
      const [col, id] = path.split("/");
      return {
        async get() { const c = (cache[col] || []).find((d) => d.id === id); const d = c || (await api("GET", `/api/doc/${col}/${encodeURIComponent(id)}`)).doc; return { exists: !!d, data: () => d && clone(d.data) }; },
        async set(data) { await api("PUT", `/api/doc/${col}/${encodeURIComponent(id)}`, { data }); },
        async delete() { await api("DELETE", `/api/doc/${col}/${encodeURIComponent(id)}`); },
      };
    },
    collection(col) { return { onSnapshot(cb, err) { (subs[col] ||= []).push({ cb, err }); refresh(col); return () => {}; } }; },
  };
  const user = { async id() { return null; }, async isOwner() { return false; }, async can() { return true; }, async me() { return { name: "", email: "" }; }, async profiles() { return {}; } };
  window.__pcc = {
    async me() { return (await api("GET", "/api/me")).userId; },
    async login(userId, pin, setupCode) { try { await api("POST", "/api/login", { userId, pin, setupCode }); stream(); refreshAll(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    async logout() { await api("POST", "/api/logout", {}); stream(); refreshAll(); },
  };
  window.claude = { use: async (n) => (n === "db" ? db : n === "user" ? user : null) };
  stream();
})();
