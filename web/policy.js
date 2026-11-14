// Server-side authority: who may see a task, what a write may change, and server timestamps.
// Mirrors the role defaults in the page so the server and the UI agree; the server has the final say.

const PERM_KEYS = ["portal_admin", "portal_leadership", "portal_user", "view_all", "view_team", "create", "assign", "edit_any", "star", "bin", "purge",
  "approve_ext", "approve_waiver", "approve_transfer", "approve_removal", "esc_manage", "poc_approve", "projects_manage", "recurring_manage",
  "drill", "kpi_all", "kpi_points", "kpi_close", "activity_view", "users_manage", "roles_manage", "settings_manage"];
const only = (keys) => Object.fromEntries(PERM_KEYS.map((k) => [k, keys.includes(k)]));
const ROLE_DEFAULTS = {
  admin: only(PERM_KEYS),
  leadership: only(["portal_leadership", "portal_user", "view_all", "create", "assign", "edit_any", "star", "bin", "approve_ext", "approve_waiver", "approve_transfer", "approve_removal", "esc_manage", "projects_manage", "recurring_manage", "drill", "kpi_all", "kpi_points", "activity_view"]),
  team_lead: only(["portal_leadership", "portal_user", "view_team", "create", "assign", "edit_any", "approve_ext", "approve_waiver", "approve_transfer", "poc_approve", "recurring_manage", "drill", "kpi_all", "activity_view"]),
  member: only(["portal_user", "create"]),
};
const REQ = { extensions: "approve_ext", waivers: "approve_waiver", removals: "approve_removal", transfers: "approve_transfer" };
export const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const deny = (error, status = 403) => ({ ok: false, status, error });

export async function loadCtx(store) {
  const [roles, team, cfg, projects, recurring] = await Promise.all(["roles", "team", "config", "projects", "recurring"].map((c) => store.list(c)));
  const map = (rows) => new Map(rows.map((r) => [r.id, r.data]));
  const config = map(cfg);
  return { roles: map(roles), team: map(team), main: config.get("main") || {}, owner: config.get("owner")?.ownerId || null, projects: map(projects), recurring: map(recurring) };
}
export function roleOf(ctx, id) { return ctx.roles.get(id)?.role || (id && id === ctx.owner ? "admin" : "member"); }
export function permsOf(ctx, id) {
  if (!id) return only([]);
  if (id === ctx.owner) return only(PERM_KEYS);
  const r = roleOf(ctx, id);
  return { ...(ROLE_DEFAULTS[r] || ROLE_DEFAULTS.member), ...(ctx.main.roleDefaults?.[r] || {}), ...(ctx.roles.get(id)?.perms || {}) };
}
const isProjLead = (ctx, me, t) => !!t?.projectId && ctx.projects.get(t.projectId)?.leaderId === me;
const levelOwner = (ctx, me) => Object.values(ctx.main.levels || {}).includes(me);
const teamOf = (ctx, lead) => [...ctx.team.entries()].filter(([, m]) => m.leadId === lead).map(([id]) => id);
export const pointsAllowed = (ctx, me) => { const P = permsOf(ctx, me); return !!P.kpi_points && roleOf(ctx, me) !== "member"; };

export function canSeeTask(ctx, me, t) {
  if (!me || !t) return false;
  const P = permsOf(ctx, me);
  if (P.view_all) return true;
  if (t.ownerId === me || (t.access || []).includes(me) || t.review?.reviewerId === me || isProjLead(ctx, me, t)) return true;
  if (t.deleted && t.deletedBy === me) return true;
  if (P.view_team && teamOf(ctx, me).includes(t.ownerId)) return true;
  if (t.esc?.active && levelOwner(ctx, me)) return true;
  if ((t.transfers || []).some((x) => x.status === "PENDING" && x.to === me)) return true;
  return false;
}

// Stamps new history entries with the server clock and the real author; earlier entries must stay as they were.
function checkHistory(prev, next, me, now) {
  const before = prev?.history || [], after = next.history || [];
  const key = (h) => `${h.at}|${h.by}|${h.text}`;
  const known = new Set(before.map(key));
  let kept = 0; const out = [];
  for (const h of after) {
    if (known.has(key(h))) { kept++; out.push(h); continue; }
    if (typeof h?.text !== "string" || h.text.length > 2000) return { error: "Invalid history entry." };
    out.push({ ...h, at: now, by: me });
  }
  const dropped = before.length - kept;
  if (dropped > 0 && (before.length < 200 || before.slice(0, dropped).some((h) => after.some((a) => key(a) === key(h))))) return { error: "Someone else changed this task a moment ago. Close it, open it again and retry.", status: 409 };
  return { history: out };
}

function checkRequests(ctx, me, P, prev, next, now, full) {
  const out = {}, decided = {};
  for (const [k, perm] of Object.entries(REQ)) {
    const before = new Map((prev?.[k] || []).map((x) => [x.id, x])), list = next[k] || [];
    if ([...before.keys()].some((id) => !list.some((x) => x.id === id))) return { error: "Requests can't be removed." };
    const res = [];
    for (const x of list) {
      const b = before.get(x.id);
      if (!b) {
        if (x.by !== me || x.status !== "PENDING") return { error: "A new request must be yours and pending." };
        const pend = (prev?.[k] || []).filter((r) => r.status === "PENDING");
        if (k === "extensions") { if (prev && prev.ownerId !== me) return { error: "Only the owner can request an extension." }; if (pend.some((r) => r.to === x.to) || list.filter((r) => r.status === "PENDING" && r.to === x.to).length > 1) return { error: `An extension to ${x.to} is already waiting for a decision.`, status: 409 }; }
        if (k === "waivers") { if (prev && prev.ownerId !== me) return { error: "Only the owner can request a waiver." }; if (pend.some((r) => (r.extId || "") === (x.extId || "") && !!r.lateCompletion === !!x.lateCompletion)) return { error: "The same waiver is already waiting for a decision.", status: 409 }; }
        if (k === "removals") { if (pend.length || list.filter((r) => r.status === "PENDING").length > 1) return { error: "A removal request for this task is already waiting for a decision.", status: 409 }; if (prev && !full) return { error: "You can't request removal of this task." }; }
        if (k === "transfers") { if (pend.length) return { error: "A transfer request is already waiting. It must be decided first.", status: 409 }; if (prev && !full) return { error: "You can't transfer this task." }; }
        res.push({ ...x, at: now });
        continue;
      }
      if (same(b, x)) { res.push(x); continue; }
      if (b.status !== "PENDING" || !["APPROVED", "REJECTED"].includes(x.status)) return { error: "This request was already decided.", status: 409 };
      const rest = (o) => { const { status, decidedBy, decidedAt, note, auto, effectiveAt, ...r } = o; return r; };
      if (!same(rest(b), rest(x))) return { error: "Only the decision on a request can change." };
      if (x.auto) { res.push({ ...x, status: "REJECTED", decidedBy: me, decidedAt: now }); (decided[k] ||= { auto: 0, manual: 0 }).auto++; continue; }
      const allowed = k === "transfers" ? (x.to === me || ((P[perm] || isProjLead(ctx, me, prev)) && x.by !== me)) : ((P[perm] || isProjLead(ctx, me, prev)) && x.by !== me);
      if (!allowed) return { error: "You can't decide this request." };
      res.push({ ...x, decidedBy: me, decidedAt: now, ...(k === "transfers" && x.status === "APPROVED" ? { effectiveAt: now } : {}) });
      (decided[k] ||= { auto: 0, manual: 0 }).manual++;
      decided[k].last = x;
    }
    if (decided[k]?.auto && !decided[k].manual) return { error: "Requests can't be closed on their own." };
    out[k] = res;
  }
  return { out, decided };
}

const FULL_ONLY = new Set(["name", "channel", "priority", "followup", "description", "projectId", "flagged", "originalDeadline", "seriesId", "occurrenceDate", "sample"]);
const REVIEWER_KEYS = new Set(["status", "review", "reviews", "completedOn", "completedAt", "completedBy", "reviewedBy", "outputLink", "esc"]);
const INVOLVED_KEYS = new Set(["pocType", "pocName", "pocMemberId", "pendingSince"]);

export function validateTaskWrite(ctx, me, prev, next) {
  if (!next || typeof next !== "object" || typeof next.name !== "string") return deny("Missing task data.", 400);
  const P = permsOf(ctx, me), now = Date.now(), today = istToday();
  const admin = !!(P.settings_manage || me === ctx.owner);
  const data = { ...next, updatedAt: now, updatedBy: me };

  if (!prev) {
    const series = next.seriesId ? ctx.recurring.get(next.seriesId) : null;
    const seriesOk = series && (series.ownerId === me || series.createdBy === me || P.recurring_manage || P.view_all);
    if (!P.create && !seriesOk) return deny("You can't create tasks.");
    if (!seriesOk && next.createdBy !== me) return deny("Tasks are created in your own name.");
    if (next.parentId) { const parent = next._parent; if (!parent || parent.parentId) return deny("A subtask needs a parent task, and subtasks can't have their own subtasks.", 400); }
    if (next.ownerId !== me && !seriesOk && !P.assign) {
      const parent = next._parent;
      if (!(parent && (parent.ownerId === me || isProjLead(ctx, me, parent)))) return deny("Assigning to someone else needs their acceptance. Send a transfer request instead.");
    }
    if (next.status !== "NOT_STARTED") return deny("New tasks start as To do.", 400);
    delete data._parent;
    Object.assign(data, { createdAt: now, completedOn: null, completedAt: null, completedBy: null, deleted: false });
    const h = checkHistory(null, next, me, now); if (h.error) return deny(h.error, 400); data.history = h.history;
    const r = checkRequests(ctx, me, P, null, next, now, true); if (r.error) return deny(r.error, r.status || 400); Object.assign(data, r.out);
    return { ok: true, data };
  }

  if (!canSeeTask(ctx, me, prev)) return deny("You don't have access to this task.");
  const full = prev.ownerId === me || !!P.edit_any || isProjLead(ctx, me, prev) || admin;
  const reviewer = prev.status === "FOR_REVIEW" && prev.review?.reviewerId === me;
  const lvl = levelOwner(ctx, me) || !!P.esc_manage;

  for (const k of ["id", "createdAt", "createdBy", "parentId"]) if (!same(prev[k], next[k])) return deny("That field can't be changed.", 400);
  const h = checkHistory(prev, next, me, now); if (h.error) return deny(h.error, h.status || 400); data.history = h.history;
  const r = checkRequests(ctx, me, P, prev, next, now, full); if (r.error) return deny(r.error, r.status || 403); Object.assign(data, r.out);
  const approved = (k) => r.decided[k]?.last?.status === "APPROVED" ? r.decided[k].last : null;

  const changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => !["version", "updatedAt", "updatedBy", "history", ...Object.keys(REQ)].includes(k) && !same(prev[k], next[k]));
  for (const k of changed) {
    if (k === "starredBy") { const a = new Set(prev.starredBy || []), b = new Set(next.starredBy || []); const diff = [...a, ...b].filter((x) => a.has(x) !== b.has(x)); if (diff.some((x) => x !== me)) return deny("Stars are personal."); continue; }
    if (k === "comments") {
      const before = prev.comments || [], after = next.comments || [];
      if (before.some((c, i) => !same(c, after[i]))) return deny("Comments can only be added.");
      const canCmt = ["admin", "leadership", "team_lead"].includes(roleOf(ctx, me)) || isProjLead(ctx, me, prev);
      if (after.length > before.length && !canCmt) return deny("Only Admin, Leadership, team leaders and project leaders can comment.");
      data.comments = [...before, ...after.slice(before.length).map((c) => ({ ...c, by: me, at: now }))];
      continue;
    }
    if (k === "deadline") { const x = approved("extensions"); if (!(x && x.to === next.deadline) && !admin) return deny("The deadline changes only through an approved extension."); continue; }
    if (k === "ownerId") { const x = approved("transfers"); if (!(x && x.to === next.ownerId) && !(full && P.assign)) return deny("Ownership changes only through an accepted transfer."); continue; }
    if (k === "deleted" || k === "deletedBy" || k === "deletedAt" || k === "deletedReason") {
      if (next.deleted && !prev.deleted) { if (!(prev.ownerId === me || P.bin || approved("removals"))) return deny("Only the owner, Admin or Leadership can bin this task."); data.deletedBy = me; data.deletedAt = now; }
      else if (!next.deleted && prev.deleted) { if (!(prev.ownerId === me || prev.deletedBy === me || P.bin)) return deny("Only the owner, Admin or Leadership can restore this task."); }
      continue;
    }
    if (k === "purgeReq") {
      const a = prev.purgeReq, b = next.purgeReq;
      if (b?.status === "PENDING" && a?.status !== "PENDING") { if (!prev.deleted || !(prev.ownerId === me || prev.deletedBy === me || P.bin)) return deny("You can't ask for this task to be deleted."); data.purgeReq = { ...b, by: me, at: now }; }
      else if (a?.status === "PENDING" && b?.status === "REJECTED") { if (!P.purge) return deny("Only an Admin decides permanent deletes."); data.purgeReq = { ...b, decidedBy: me, decidedAt: now }; }
      else if (!b && !next.deleted) { /* cleared on restore */ }
      else return deny("Invalid delete request.", 400);
      continue;
    }
    if (k === "access") { if (full) continue; const added = (next.access || []).filter((x) => !(prev.access || []).includes(x)), removed = (prev.access || []).filter((x) => !(next.access || []).includes(x)); if (removed.some((x) => x !== next.ownerId)) return deny("You can't remove people from this task."); if (added.length && !(reviewer || lvl || approved("transfers"))) return deny("You can't share this task."); continue; }
    if (k === "esc") { if (full || lvl || reviewer) continue; return deny("You can't change this escalation."); }
    if (REVIEWER_KEYS.has(k)) { if (full || (reviewer && (k !== "status" || ["COMPLETED", "IN_PROGRESS"].includes(next.status)))) continue; if (k === "status" && approved("transfers")) continue; return deny("You can't change this task's status."); }
    if (INVOLVED_KEYS.has(k)) { if (full || (prev.access || []).includes(me) || reviewer) continue; return deny("You can't change Pending From on this task."); }
    if (k.startsWith("_")) { delete data[k]; continue; }
    if (FULL_ONLY.has(k) || !full) { if (!full) return deny("Only the owner or someone who can edit others' tasks can change this."); }
  }

  // Status bookkeeping uses the server clock.
  if (next.status === "FOR_REVIEW" && prev.status !== "FOR_REVIEW") {
    if (!next.review?.reviewerId || next.review.reviewerId === prev.ownerId) return deny("Pick a reviewer other than the owner.", 400);
    data.review = { ...next.review, submittedAt: now, submittedOn: today, firstSubmittedOn: prev.review?.firstSubmittedOn || today, by: me };
  }
  if (next.status === "COMPLETED" && prev.status !== "COMPLETED") Object.assign(data, { completedAt: now, completedBy: prev.ownerId, completedOn: prev.status === "FOR_REVIEW" ? (prev.review?.firstSubmittedOn || today) : today });
  if (next.status !== "COMPLETED" && prev.status === "COMPLETED") Object.assign(data, { completedAt: null, completedBy: null, completedOn: null });
  if (next.status === "COMPLETED" && prev.status === "COMPLETED") Object.assign(data, { completedAt: prev.completedAt ?? data.completedAt, completedBy: prev.completedBy ?? data.completedBy, completedOn: prev.completedOn ?? data.completedOn });
  if (next.esc?.active === false && prev.esc?.active) data.esc = { ...next.esc, resolvedAt: now, resolvedBy: me };
  if (next.esc?.active && !prev.esc?.active) data.esc = { ...next.esc, at: now, by: me };
  return { ok: true, data };
}

export function canWriteProject(ctx, me, prev, next) {
  const P = permsOf(ctx, me);
  if (!prev) return P.create ? null : "You can't create projects.";
  if (prev.ownerId === me || prev.leaderId === me || P.projects_manage || P.settings_manage) return null;
  return "Only the project owner, its leader or someone who manages projects can change it.";
}
export function canWriteSeries(ctx, me, prev, next) {
  const P = permsOf(ctx, me);
  if (!prev) return P.create && (next.ownerId === me || P.recurring_manage) ? null : "You can create recurring series for yourself only.";
  if (prev.ownerId === me || prev.createdBy === me || P.recurring_manage || P.view_all) return null;
  return "You can't change this series.";
}
// Members never receive KPI points from the server.
export function stripPoints(rows) { return rows.map((r) => ({ ...r, delivery: undefined, disc: undefined, total: undefined, deps: undefined })); }
