// Daily digest emails, in IST:
//   09:00  each person gets their own open work for the day; every Admin gets one team-wide summary.
//   21:00  each person gets what they finished today and what is still pending; every Admin gets one team-wide summary.
// A marker in the database makes each digest go out once per day, even after restarts. If the app was asleep
// at 9 (free hosting), the digest goes out as soon as it wakes: morning until 12:00, evening until midnight.
import { istToday } from "./policy.js";
import { render, send, emailInfo, esc, fmtD, STATUS, APP_URL } from "./mailer.js";

const OPEN = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "FOR_REVIEW"];
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const istNow = () => { const d = new Date(Date.now() + 330 * 60000); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };
const byDue = (a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999") || (a.priority ?? 9) - (b.priority ?? 9);
const link = (t) => `${APP_URL}/?task=${encodeURIComponent(t.id)}`;

// ---------- building blocks ----------
const H = (txt, color = "#0F172A") => `<div style="margin:22px 0 8px;font-size:15px;font-weight:800;color:${color}">${txt}</div>`;
function taskList(tasks, today, { who, max = 15 } = {}) {
  if (!tasks.length) return "";
  const rows = tasks.slice(0, max).map((t) => {
    const late = OPEN.includes(t.status) && t.deadline && t.deadline < today;
    return `<tr><td style="padding:9px 12px;border-top:1px solid #EEF1F6;vertical-align:top">
      <a href="${esc(link(t))}" style="color:#0F172A;font-weight:700;text-decoration:none;font-size:14px">${esc(t.name)}</a>
      <div style="font-size:12px;color:#8E98AB;margin-top:2px">${esc(t.id)} · P${t.priority ?? "-"} · ${esc(t.channel || "")}${who ? ` · ${esc(who(t.ownerId))}` : ""} · ${esc(STATUS[t.status] || t.status)}</div></td>
      <td style="padding:9px 12px;border-top:1px solid #EEF1F6;vertical-align:top;text-align:right;white-space:nowrap;font-size:13px;font-weight:700;color:${late ? "#D92D20" : "#475467"}">${t.status === "COMPLETED" ? "Done" : fmtD(t.deadline)}${late ? "<br><span style='font-size:11px'>overdue</span>" : ""}</td></tr>`;
  }).join("");
  const more = tasks.length > max ? `<tr><td colspan="2" style="padding:8px 12px;border-top:1px solid #EEF1F6;font-size:12px;color:#8E98AB">+ ${tasks.length - max} more in the app</td></tr>` : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E3E7EF;border-radius:12px;border-collapse:separate;overflow:hidden">${rows}${more}</table>`;
}
const textList = (tasks, today, who) => tasks.map((t) => `- ${t.name} (${t.id}) · ${t.status === "COMPLETED" ? "done" : "due " + fmtD(t.deadline)}${OPEN.includes(t.status) && t.deadline < today ? " · OVERDUE" : ""}${who ? " · " + who(t.ownerId) : ""}`).join("\n");
function stats(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 4px"><tr>${items.map(([label, n, color]) => `<td style="padding:4px"><div style="border:1px solid #E3E7EF;border-radius:12px;padding:12px;text-align:center"><div style="font-size:22px;font-weight:800;color:${n && color ? color : "#0F172A"}">${n}</div><div style="font-size:12px;color:#8E98AB;font-weight:700">${label}</div></div></td>`).join("")}</tr></table>`;
}
function teamTable(rows, cols) {
  const th = cols.map(([h]) => `<th style="padding:8px 8px;font-size:11px;color:#8E98AB;text-align:${h === "Person" ? "left" : "center"};font-weight:800;text-transform:uppercase;letter-spacing:.04em">${h}</th>`).join("");
  const body = rows.map((r) => `<tr>${cols.map(([h, f, color]) => { const v = f(r); return `<td style="padding:8px;border-top:1px solid #EEF1F6;font-size:13px;text-align:${h === "Person" ? "left" : "center"};font-weight:${h === "Person" ? 700 : 600};color:${color && v ? color : "#0F172A"}">${esc(v)}</td>`; }).join("")}</tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E3E7EF;border-radius:12px;border-collapse:separate"><tr style="background:#F8FAFC">${th}</tr>${body}</table>`;
}

// ---------- data ----------
async function snapshot(store) {
  const team = Object.fromEntries((await store.list("team")).map((d) => [d.id, d.data]));
  const roles = Object.fromEntries((await store.list("roles")).map((d) => [d.id, d.data]));
  const owner = (await store.get("config", "owner"))?.data?.ownerId;
  const tasks = (await store.list("tasks")).map((d) => d.data).filter((t) => t && !t.deleted);
  const roleOf = (id) => roles[id]?.role || (id === owner ? "admin" : "member");
  const name = (id) => team[id]?.alias || team[id]?.displayName || "Unassigned";
  const people = Object.keys(team).filter((id) => !team[id].removed && team[id].email).map((id) => ({ id, name: name(id), email: team[id].email, role: roleOf(id) }));
  return { tasks, people, name };
}
function forPerson(tasks, id, today, dayStart) {
  const mine = tasks.filter((t) => t.ownerId === id);
  const open = mine.filter((t) => OPEN.includes(t.status)).sort(byDue);
  const touchedToday = (t) => (t.history || []).some((h) => (h.at || 0) >= dayStart && h.by === id);
  return {
    open,
    overdue: open.filter((t) => t.deadline && t.deadline < today),
    dueToday: open.filter((t) => t.deadline === today),
    soon: open.filter((t) => t.deadline > today && t.deadline <= addDays(today, 3)),
    later: open.filter((t) => !t.deadline || t.deadline > addDays(today, 3)),
    done: mine.filter((t) => t.status === "COMPLETED" && (t.completedOn === today || (t.completedAt || 0) >= dayStart)),
    worked: open.filter(touchedToday),
    toReview: tasks.filter((t) => t.status === "FOR_REVIEW" && t.review?.reviewerId === id),
    toAccept: tasks.filter((t) => (t.transfers || []).some((x) => x.status === "PENDING" && x.to === id)),
  };
}

// ---------- emails ----------
function personalMorning(p, s, today) {
  const n = s.open.length;
  const body = [
    stats([["Open", n], ["Overdue", s.overdue.length, "#D92D20"], ["Due today", s.dueToday.length, "#B54708"]]),
    s.overdue.length ? H("Overdue: finish these first", "#D92D20") + taskList(s.overdue, today) : "",
    s.dueToday.length ? H("Due today", "#B54708") + taskList(s.dueToday, today) : "",
    s.soon.length ? H("Due in the next 3 days") + taskList(s.soon, today) : "",
    s.toReview.length ? H("Waiting for your review", "#7C3AED") + taskList(s.toReview, today) : "",
    s.toAccept.length ? H("Asked to take over", "#7C3AED") + taskList(s.toAccept, today) : "",
    s.later.length ? H("Later") + taskList(s.later, today, { max: 8 }) : "",
  ].join("");
  const text = [`Open ${n} · Overdue ${s.overdue.length} · Due today ${s.dueToday.length}`, s.overdue.length ? "\nOVERDUE\n" + textList(s.overdue, today) : "", s.dueToday.length ? "\nDUE TODAY\n" + textList(s.dueToday, today) : "", s.soon.length ? "\nNEXT 3 DAYS\n" + textList(s.soon, today) : ""].join("\n");
  return render({ eyebrow: `Good morning · ${fmtD(today)}`, title: `${p.name.split(" ")[0]}, here's your work for today`, intro: n ? `You have <b>${n}</b> open task${n === 1 ? "" : "s"}${s.overdue.length ? `, <b style="color:#D92D20">${s.overdue.length} overdue</b>` : ""}.` : "You have no open tasks. Nice!", preheader: `${s.dueToday.length} due today · ${s.overdue.length} overdue`, body, bodyText: text, cta: "Open my tasks", url: APP_URL });
}
function personalEvening(p, s, today) {
  const body = [
    stats([["Done today", s.done.length, "#067647"], ["Still open", s.open.length], ["Overdue", s.overdue.length, "#D92D20"]]),
    s.done.length ? H("Finished today ✓", "#067647") + taskList(s.done, today) : "",
    s.worked.length ? H("Worked on today") + taskList(s.worked, today) : "",
    s.overdue.length ? H("Pending: overdue", "#D92D20") + taskList(s.overdue, today) : "",
    s.open.filter((t) => !s.overdue.includes(t)).length ? H("Pending") + taskList(s.open.filter((t) => !s.overdue.includes(t)), today, { max: 12 }) : "",
  ].join("");
  const text = [`Done today ${s.done.length} · Still open ${s.open.length} · Overdue ${s.overdue.length}`, s.done.length ? "\nDONE TODAY\n" + textList(s.done, today) : "", s.open.length ? "\nPENDING\n" + textList(s.open, today) : ""].join("\n");
  return render({ eyebrow: `Day summary · ${fmtD(today)}`, tone: "#067647", title: s.done.length ? `You finished ${s.done.length} task${s.done.length === 1 ? "" : "s"} today` : "Your day in Palmonas", intro: s.open.length ? `<b>${s.open.length}</b> task${s.open.length === 1 ? " is" : "s are"} still pending${s.overdue.length ? `, <b style="color:#D92D20">${s.overdue.length} overdue</b>` : ""}.` : "Nothing pending. Great work!", preheader: `${s.done.length} done · ${s.open.length} pending`, body, bodyText: text, cta: "Open my tasks", url: APP_URL });
}
function teamEmail(kind, admin, all, tasks, name, today) {
  const rows = all.map((r) => r).sort((a, b) => b.s.overdue.length - a.s.overdue.length || b.s.open.length - a.s.open.length);
  const sum = (f) => rows.reduce((n, r) => n + f(r.s).length, 0);
  const overdue = rows.flatMap((r) => r.s.overdue).sort(byDue), dueToday = rows.flatMap((r) => r.s.dueToday).sort(byDue), done = rows.flatMap((r) => r.s.done);
  const morning = kind === "morning";
  const cols = morning
    ? [["Person", (r) => r.p.name], ["Open", (r) => r.s.open.length], ["Due today", (r) => r.s.dueToday.length, "#B54708"], ["Overdue", (r) => r.s.overdue.length, "#D92D20"]]
    : [["Person", (r) => r.p.name], ["Done today", (r) => r.s.done.length, "#067647"], ["Worked on", (r) => r.s.worked.length], ["Pending", (r) => r.s.open.length], ["Overdue", (r) => r.s.overdue.length, "#D92D20"]];
  const body = [
    morning ? stats([["Open", sum((s) => s.open)], ["Due today", dueToday.length, "#B54708"], ["Overdue", overdue.length, "#D92D20"]])
      : stats([["Done today", done.length, "#067647"], ["Pending", sum((s) => s.open)], ["Overdue", overdue.length, "#D92D20"]]),
    H(morning ? "Who has what today" : "Who did what today") + teamTable(rows.filter((r) => r.s.open.length || r.s.done.length || r.s.worked.length), cols),
    !morning && done.length ? H("Finished today ✓", "#067647") + taskList(done, today, { who: name, max: 20 }) : "",
    morning && dueToday.length ? H("Due today", "#B54708") + taskList(dueToday, today, { who: name, max: 20 }) : "",
    overdue.length ? H("Overdue across the team", "#D92D20") + taskList(overdue, today, { who: name, max: 20 }) : "",
  ].join("");
  const text = [...rows.map((r) => morning ? `${r.p.name}: open ${r.s.open.length}, due today ${r.s.dueToday.length}, overdue ${r.s.overdue.length}` : `${r.p.name}: done ${r.s.done.length}, pending ${r.s.open.length}, overdue ${r.s.overdue.length}`), done.length && !morning ? "\nDONE TODAY\n" + textList(done, today, name) : "", overdue.length ? "\nOVERDUE\n" + textList(overdue, today, name) : ""].join("\n");
  return render({ eyebrow: `${morning ? "Team · morning" : "Team · evening"} · ${fmtD(today)}`, tone: morning ? "#2563EB" : "#067647", title: morning ? "Team work for today" : "What the team did today", intro: morning ? `<b>${dueToday.length}</b> task${dueToday.length === 1 ? " is" : "s are"} due today and <b style="color:#D92D20">${overdue.length}</b> overdue across the team.` : `The team finished <b>${done.length}</b> task${done.length === 1 ? "" : "s"} today. <b>${sum((s) => s.open)}</b> still pending, <b style="color:#D92D20">${overdue.length}</b> overdue.`, preheader: morning ? `${dueToday.length} due today · ${overdue.length} overdue` : `${done.length} done · ${overdue.length} overdue`, body, bodyText: text, cta: "Open Command Center", url: APP_URL });
}

export async function buildDigest(store, kind) {
  const today = istToday(), dayStart = Date.parse(today + "T00:00:00+05:30");
  const { tasks, people, name } = await snapshot(store);
  const all = people.map((p) => ({ p, s: forPerson(tasks, p.id, today, dayStart) }));
  const out = [];
  for (const { p, s } of all) {
    if (p.role === "admin") out.push([p, `[Palmonas] ${kind === "morning" ? "Team work for today" : "Team summary"} · ${fmtD(today)}`, teamEmail(kind, p, all, tasks, name, today)]);
    else if (kind === "morning" ? s.open.length || s.toReview.length || s.toAccept.length : s.open.length || s.done.length)
      out.push([p, kind === "morning" ? `[Palmonas] Your work for today · ${fmtD(today)}` : `[Palmonas] Your day summary · ${fmtD(today)}`, kind === "morning" ? personalMorning(p, s, today) : personalEvening(p, s, today)]);
  }
  return out;
}

export function startDigests(store, log) {
  let busy = false;
  const tick = async () => {
    if (busy || !emailInfo().on) return;
    const { date, hour } = istNow();
    const kind = hour >= 21 ? "evening" : hour >= 9 && hour < 12 ? "morning" : null;
    if (!kind) return;
    busy = true;
    try {
      const mark = (await store.get("jobs", "digest"))?.data || {};
      // People whose digest failed get it again on the next tick, up to 3 tries in all.
      const retry = mark.retry?.kind === kind && mark.retry?.date === date && (mark.retry.tries || 0) < 3 ? mark.retry : null;
      if (mark[kind] === date && !retry?.ids?.length) return;
      const mails = (await buildDigest(store, kind)).filter(([p]) => !retry || retry.ids.includes(p.id));
      await store.put("jobs", "digest", { ...mark, [kind]: date, retry: null });
      const failed = [];
      for (const [p, subject, mail] of mails) failed.push(...await send([p], subject, mail, log));
      if (failed.length) await store.put("jobs", "digest", { ...mark, [kind]: date, retry: { kind, date, ids: failed, tries: (retry?.tries || 0) + 1 } });
      log("info", retry ? "digest resent" : "digest sent", { kind, date, count: mails.length, failed: failed.length });
    } catch (e) { log("error", "digest failed", { kind, error: e.message }); } finally { busy = false; }
  };
  setTimeout(tick, 8000); setInterval(tick, 60000).unref();
}
