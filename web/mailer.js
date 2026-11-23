// Email notifications: works out which events a document change represents, who should hear about it,
// and sends a branded HTML email through Brevo, Resend (HTTPS APIs) or SMTP. Off when none is configured.
const PROVIDER = process.env.BREVO_API_KEY ? "brevo" : process.env.RESEND_API_KEY ? "resend" : process.env.SMTP_HOST && process.env.SMTP_PASS ? "smtp" : "";
export const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
const FROM = parseFrom(process.env.MAIL_FROM || "");
export const PRIO = ["Critical", "Urgent", "High", "Normal", "Low", "Backlog"];
export const STATUS = { NOT_STARTED: "To do", IN_PROGRESS: "In progress", ON_HOLD: "On hold", FOR_REVIEW: "For review", COMPLETED: "Completed", DROPPED: "Dropped" };
const ROLE = { admin: "Admin", leadership: "Leadership", team_lead: "Team Leader", member: "Team member" };

function parseFrom(v) { const m = v.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/); return m ? { name: m[1].replace(/^"|"$/g, "") || "Palmonas Command Center", email: m[2] } : { name: "Palmonas Command Center", email: v.trim() }; }
export const emailInfo = () => ({ provider: PROVIDER, on: !!(PROVIDER && FROM.email) });
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtD = (iso) => iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";

// ---------- template ----------
export function render({ preheader, eyebrow, title, intro, task, people, details = [], quote, cta, url, tone = "#2563EB", body = "", bodyText = "" }) {
  const chip = (txt, bg, fg) => `<span style="display:inline-block;padding:3px 10px;border-radius:99px;background:${bg};color:${fg};font-size:12px;font-weight:700;margin:0 6px 6px 0">${esc(txt)}</span>`;
  const late = task && ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"].includes(task.status) && task.deadline < new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const taskCard = task ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E3E7EF;border-radius:14px;background:#F8FAFC;margin:18px 0 6px"><tr><td style="padding:18px 20px">
    <div style="font:600 12px Menlo,Consolas,monospace;color:#8E98AB;margin-bottom:6px">${esc(task.id)}</div>
    <div style="font-size:17px;font-weight:800;color:#0F172A;line-height:1.35;margin-bottom:12px">${esc(task.name)}</div>
    ${chip(`P${task.priority} · ${PRIO[task.priority] || ""}`, task.priority === 0 ? "#FEE4E2" : task.priority <= 2 ? "#FEF0C7" : "#EEF2F6", task.priority === 0 ? "#B42318" : task.priority <= 2 ? "#B54708" : "#475467")}${chip(task.channel, "#EEF3FF", "#2563EB")}${chip(STATUS[task.status] || task.status, "#ECFDF3", "#067647")}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;font-size:13px;color:#475467">
      <tr><td style="padding:3px 18px 3px 0;color:#8E98AB">Deadline</td><td style="padding:3px 0;font-weight:700;color:${late ? "#D92D20" : "#0F172A"}">${fmtD(task.deadline)}${late ? " · overdue" : ""}</td></tr>
      ${people?.owner ? `<tr><td style="padding:3px 18px 3px 0;color:#8E98AB">Owner</td><td style="padding:3px 0;font-weight:700;color:#0F172A">${esc(people.owner)}</td></tr>` : ""}
      ${task.pocName ? `<tr><td style="padding:3px 18px 3px 0;color:#8E98AB">Waiting on</td><td style="padding:3px 0;font-weight:700;color:#0F172A">${esc(task.pocName)}</td></tr>` : ""}
      ${details.map(([k, v]) => `<tr><td style="padding:3px 18px 3px 0;color:#8E98AB">${esc(k)}</td><td style="padding:3px 0;font-weight:700;color:#0F172A">${esc(v)}</td></tr>`).join("")}
    </table></td></tr></table>` : details.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;font-size:14px;color:#475467">${details.map(([k, v]) => `<tr><td style="padding:4px 18px 4px 0;color:#8E98AB">${esc(k)}</td><td style="padding:4px 0;font-weight:700;color:#0F172A">${esc(v)}</td></tr>`).join("")}</table>` : "";
  const quoteHtml = quote ? `<div style="margin:14px 0 4px;padding:12px 16px;border-left:3px solid ${tone};background:#F8FAFC;border-radius:0 10px 10px 0;font-size:14px;color:#344054;font-style:italic">“${esc(quote)}”</div>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || intro || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F6;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
  <tr><td style="background:#0F1B33;border-radius:18px 18px 0 0;padding:20px 26px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="width:34px;height:34px;border-radius:50%;background:#1E2C4D;text-align:center;vertical-align:middle;color:#D9F99D;font-size:18px;font-weight:800">⚡</td>
      <td style="padding-left:10px"><div style="color:#fff;font-size:16px;font-weight:800;line-height:1.1">Palmonas</div><div style="color:#A9B8D6;font-size:10px;letter-spacing:.14em;font-weight:700">COMMAND CENTER</div></td>
    </tr></table></td></tr>
  <tr><td style="background:#ffffff;padding:28px 26px 26px;border-radius:0 0 18px 18px">
    ${eyebrow ? `<div style="display:inline-block;padding:4px 10px;border-radius:99px;background:${tone}1A;color:${tone};font-size:12px;font-weight:800;letter-spacing:.02em;margin-bottom:12px">${esc(eyebrow)}</div>` : ""}
    <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:#0F172A;font-weight:800">${esc(title)}</h1>
    ${intro ? `<p style="margin:0;font-size:15px;line-height:1.6;color:#475467">${intro}</p>` : ""}
    ${quoteHtml}${taskCard}${body}
    ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr><td style="border-radius:12px;background:${tone}"><a href="${esc(url)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:12px">${esc(cta)} →</a></td></tr></table>
    <p style="margin:14px 0 0;font-size:12px;color:#8E98AB">Button not working? Open <a href="${esc(url)}" style="color:#2563EB">${esc(url)}</a></p>` : ""}
  </td></tr>
  <tr><td style="padding:18px 26px;text-align:center;font-size:12px;line-height:1.6;color:#8E98AB">You're receiving this because you're on the Palmonas team workspace.<br>Times are in IST · <a href="${esc(APP_URL)}" style="color:#8E98AB">Open Palmonas Command Center</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [title, "", (intro || "").replace(/<[^>]+>/g, ""), quote ? `"${quote}"` : "", task ? `${task.id} · ${task.name}\nP${task.priority} · ${task.channel} · ${STATUS[task.status] || ""} · due ${fmtD(task.deadline)}` : "", ...details.map(([k, v]) => `${k}: ${v}`), bodyText, "", cta ? `${cta}: ${url}` : "", "", "Palmonas Command Center"].filter((x) => x !== null).join("\n");
  return { html, text };
}

// ---------- sending ----------
let smtp;
export async function send(to, subject, { html, text }, log) {
  const failed = [];
  if (!emailInfo().on || !to.length) return failed;
  for (const r of to) for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (PROVIDER === "brevo") {
        const res = await fetch(process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ sender: FROM, to: [{ email: r.email, name: r.name }], subject, htmlContent: html, textContent: text }) });
        if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
      } else if (PROVIDER === "resend") {
        const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: `${FROM.name} <${FROM.email}>`, to: [r.email], subject, html, text }) });
        if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      } else if (PROVIDER === "smtp") {
        if (!smtp) { const { default: nm } = await import("nodemailer"); smtp = nm.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000 }); }
        await smtp.sendMail({ from: `"${FROM.name}" <${FROM.email}>`, to: `"${r.name}" <${r.email}>`, subject, html, text });
      }
      log("info", "email sent", { to: r.id, subject });
      break;
    } catch (e) {
      // A dropped SMTP connection is common on free hosting: start a fresh one and try once more.
      smtp = null;
      log(attempt === 1 ? "warn" : "error", attempt === 1 ? "email retrying" : "email failed", { to: r.id, error: e.message });
      if (attempt === 2) failed.push(r.id); else await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
  return failed;
}

// ---------- who gets what ----------
export function createNotifier(store, log) {
  async function directory() {
    const team = Object.fromEntries((await store.list("team")).map((d) => [d.id, d.data]));
    const roles = Object.fromEntries((await store.list("roles")).map((d) => [d.id, d.data]));
    const owner = (await store.get("config", "owner"))?.data?.ownerId;
    const name = (id) => team[id]?.alias || team[id]?.displayName || "A teammate";
    const person = (id) => { const t = team[id]; return t && !t.removed && t.email ? { id, name: name(id), email: t.email } : null; };
    const roleOf = (id) => roles[id]?.role || (id === owner ? "admin" : "member");
    return { team, roles, name, person, roleOf };
  }
  const approversFor = (dir, task, permKey) => Object.keys(dir.team).filter((id) => {
    const p = dir.roles[id]?.perms || {};
    if (p[permKey] === false) return false;
    if (p[permKey] === true) return true;
    const r = dir.roleOf(id);
    return r === "admin" || r === "leadership" || (r === "team_lead" && dir.team[task.ownerId]?.leadId === id);
  });
  const recips = (dir, ids, actor) => [...new Set(ids)].filter((id) => id && id !== actor).map(dir.person).filter(Boolean);
  const link = (task) => `${APP_URL}/?task=${encodeURIComponent(task.id)}`;

  async function onTask(prev, next, actor) {
    if (!emailInfo().on || !next || next.deleted && prev?.deleted) return;
    const dir = await directory(), who = dir.name(actor), owner = { owner: dir.name(next.ownerId) };
    const out = [];
    const add = (ids, subject, opts) => out.push([recips(dir, ids, actor), subject, render({ task: next, people: owner, url: link(next), cta: "Open task", ...opts })]);
    const isNew = !prev;
    if (isNew && next.ownerId !== actor) add([next.ownerId], `[Palmonas] New task for you · ${next.id}`, { eyebrow: "New task", title: "You've been assigned a task", intro: `<b>${esc(who)}</b> assigned you a task. It's due ${fmtD(next.deadline)}.`, preheader: next.name });
    if (prev && prev.ownerId !== next.ownerId) add([next.ownerId], `[Palmonas] Task now yours · ${next.id}`, { eyebrow: "Reassigned", title: "A task is now yours", intro: `This task moved from <b>${esc(dir.name(prev.ownerId))}</b> to you.`, preheader: next.name });
    const diff = (key) => { const before = Object.fromEntries((prev?.[key] || []).map((x) => [x.id, x])); return (next[key] || []).map((x) => [before[x.id], x]); };
    for (const [b, x] of diff("transfers")) {
      if (!b && x.status === "PENDING") add([x.to], `[Palmonas] Transfer request · ${next.id}`, { eyebrow: "Transfer request", tone: "#7C3AED", title: `${who} wants you to take over a task`, intro: "It stays with the current owner until you accept.", quote: x.reason, cta: "Review request" });
      if (b?.status === "PENDING" && x.status !== "PENDING") add([x.by, x.from], `[Palmonas] Transfer ${x.status === "APPROVED" ? "accepted" : "declined"} · ${next.id}`, { eyebrow: x.status === "APPROVED" ? "Transfer accepted" : "Transfer declined", tone: x.status === "APPROVED" ? "#067647" : "#D92D20", title: `${dir.name(x.to)} ${x.status === "APPROVED" ? "took over" : "declined"} the task`, quote: x.note });
    }
    for (const [key, label, perm] of [["extensions", "Extension", "approve_ext"], ["waivers", "Waiver", "approve_waiver"], ["removals", "Removal", "approve_removal"]]) for (const [b, x] of diff(key)) {
      if (!b && x.status === "PENDING") add(approversFor(dir, next, perm), `[Palmonas] ${label} request · ${next.id}`, { eyebrow: `${label} request`, tone: "#B54708", title: `${who} asked for ${label === "Extension" ? "an extension" : label === "Waiver" ? "a waiver" : "this task to be removed"}`, intro: label === "Extension" ? `Deadline <b>${fmtD(x.from)}</b> → <b>${fmtD(x.to)}</b>.${x.afterCompletion ? " Requested after completion." : ""}` : label === "Waiver" ? "A waiver is decided on its own and doesn't change the deadline." : "Approving moves it to the Recycle Bin.", quote: x.reason, cta: "Review request" });
      if (b?.status === "PENDING" && x.status !== "PENDING") add([x.by, next.ownerId], `[Palmonas] ${label} ${x.status === "APPROVED" ? "approved" : "rejected"} · ${next.id}`, { eyebrow: `${label} ${x.status.toLowerCase()}`, tone: x.status === "APPROVED" ? "#067647" : "#D92D20", title: `Your ${label.toLowerCase()} request was ${x.status === "APPROVED" ? "approved" : "rejected"}`, intro: `Decided by <b>${esc(dir.name(x.decidedBy))}</b>.${label === "Extension" && x.status === "APPROVED" ? ` The new deadline is <b>${fmtD(x.to)}</b>.` : ""}`, quote: x.note });
    }
    const e0 = prev?.esc, e1 = next.esc;
    if (e1?.active && (!e0?.active || e0.assignee !== e1.assignee || e0.level !== e1.level)) add([e1.assignee, next.ownerId], `[Palmonas] Escalation ${e1.level} · ${next.id}`, { eyebrow: `Escalated to ${e1.level}`, tone: "#D92D20", title: e0?.active ? `Escalation moved to ${e1.level}` : `${who} escalated a task to ${e1.level}`, intro: `Assigned to <b>${esc(dir.name(e1.assignee))}</b>. This needs someone senior to step in.`, quote: e1.reason, cta: "Open escalation" });
    if (e0?.active && e1 && !e1.active) add([next.ownerId, e0.by], `[Palmonas] Escalation resolved · ${next.id}`, { eyebrow: "Escalation resolved", tone: "#067647", title: "The escalation is resolved", quote: e1.resolution });
    if (prev && prev.status !== "COMPLETED" && next.status === "COMPLETED") add([next.createdBy], `[Palmonas] Task completed · ${next.id}`, { eyebrow: "Completed", tone: "#067647", title: `${who} completed a task you created`, intro: next.completedOn && next.completedOn <= next.deadline ? "Finished on time." : "Finished after the deadline." });
    const r0 = prev?.review, r1 = next.review;
    if (next.status === "FOR_REVIEW" && r1?.reviewerId && (prev?.status !== "FOR_REVIEW" || r0?.reviewerId !== r1.reviewerId)) add([r1.reviewerId], `[Palmonas] Review requested · ${next.id}`, { eyebrow: "Review requested", tone: "#7C3AED", title: `${who} sent you a task to review`, intro: "Accept it to complete the task, send it back, or pass it to someone else.", quote: r1.note || undefined });
    if (prev?.status === "FOR_REVIEW" && next.status !== "FOR_REVIEW" && actor !== next.ownerId) add([next.ownerId], `[Palmonas] Review ${next.status === "COMPLETED" ? "accepted" : "sent back"} · ${next.id}`, { eyebrow: next.status === "COMPLETED" ? "Review accepted" : "Sent back", tone: next.status === "COMPLETED" ? "#067647" : "#B54708", title: next.status === "COMPLETED" ? `${who} accepted your work` : `${who} sent your task back`, quote: (next.reviews || []).slice(-1)[0]?.reason || undefined });
    if (prev && prev.priority !== next.priority && next.priority < prev.priority) add([next.ownerId], `[Palmonas] Priority raised · ${next.id}`, { eyebrow: "Priority changed", tone: "#B54708", title: `Priority raised to P${next.priority}`, intro: `<b>${esc(who)}</b> changed it from P${prev.priority} to P${next.priority}.` });
    if (prev && !prev.deleted && next.deleted) add([next.ownerId], `[Palmonas] Task moved to the Bin · ${next.id}`, { eyebrow: "Removed", tone: "#475467", title: "A task of yours was moved to the Recycle Bin", intro: `By <b>${esc(who)}</b>. It can be restored.`, quote: next.deletedReason, cta: null });
    // Owner, creator, Admin and Leadership hear about every change, unless an email above already told them.
    // Bulk imports skip this, so a 500-row upload doesn't send 500 emails to every Admin.
    if (!(isNew && next.importSource)) {
      const lastAt = Math.max(0, ...(prev?.history || []).map((h) => h.at || 0));
      const lines = (next.history || []).filter((h) => (h.at || 0) > lastAt).map((h) => `${dir.name(h.by)} ${h.text}`);
      if (isNew || lines.length) {
        const told = new Set(out.flatMap(([to]) => to.map((r) => r.id)));
        const watchers = [next.ownerId, next.createdBy, ...Object.keys(dir.team).filter((id) => ["admin", "leadership"].includes(dir.roleOf(id)))];
        const to = recips(dir, watchers, actor).filter((r) => !told.has(r.id));
        const list = lines.length ? `<div style="margin:16px 0 0;font-size:13px;font-weight:700;color:#8E98AB">What changed</div><ul style="margin:6px 0 0;padding-left:18px;font-size:14px;line-height:1.6;color:#344054">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
        if (to.length) out.push([to, `[Palmonas] ${isNew ? "New task" : "Task updated"} · ${next.id} · ${next.name}`, render({ task: next, people: owner, url: link(next), cta: "Open task", eyebrow: isNew ? "New task" : "Task updated", title: isNew ? `${who} created a task` : `${who} updated a task`, preheader: lines[lines.length - 1] || next.name, body: list, bodyText: lines.length ? "What changed:\n" + lines.map((l) => "- " + l).join("\n") : "" })]);
      }
    }
    for (const [to, subject, mail] of out) await send(to, subject, mail, log);
  }

  async function onInvite(prev, next, actor) {
    if (!emailInfo().on || !next?.email || next.status !== "PENDING") return;
    const fresh = !prev || prev.status !== "PENDING" || (next.resentAt && next.resentAt !== prev.resentAt);
    if (!fresh) return;
    const dir = await directory();
    const first = (next.name || "").split(" ")[0];
    const mail = render({ eyebrow: "You're invited", tone: "#7C3AED", title: `${first ? first + ", j" : "J"}oin the Palmonas team workspace`, intro: `<b>${esc(dir.name(next.invitedBy || actor))}</b> invited you to the Palmonas Command Center as <b>${esc(ROLE[next.role] || "Team member")}</b>: your tasks, deadlines, approvals and escalations in one place, updated live.`, quote: next.message || null, details: [["Sign in with", next.email], ["Role", ROLE[next.role] || "Team member"]], cta: "Accept invitation", url: APP_URL, preheader: "Sign in with Google to get started." });
    await send([{ id: next.id, name: next.name || next.email, email: next.email }], `[Palmonas] You're invited to the Command Center`, mail, log);
  }
  return { onTask, onInvite };
}
export const previewEmail = (kind) => render(kind === "invite"
  ? { eyebrow: "You're invited", tone: "#7C3AED", title: "Neha, join the Palmonas team workspace", intro: "<b>Harsh</b> invited you to the Palmonas Command Center as <b>Team member</b>: your tasks, deadlines, approvals and escalations in one place, updated live.", details: [["Sign in with", "neha@palmonas.com"], ["Role", "Team member"]], cta: "Accept invitation", url: APP_URL }
  : { eyebrow: "New task", title: "You've been assigned a task", intro: "<b>Harsh</b> assigned you a task. It's due 20 Nov 2026.", task: { id: "HSH-261113-A1B2", name: "Blinkit Diwali hamper pricing", priority: 1, channel: "Blinkit", status: "NOT_STARTED", deadline: "2026-11-20", pocName: "Brand Merchandising" }, people: { owner: "Pragati" }, cta: "Open task", url: `${APP_URL}/?task=HSH-261113-A1B2` });
