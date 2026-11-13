const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const base = () => (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Deep links open the app, which re-authenticates and re-checks permission; links never perform actions (§28.3).
export const taskLink = (id: string) => `${base()}/tasks/${encodeURIComponent(id)}`;

function shell(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#F8F9FA;font-family:Roboto,Arial,sans-serif;color:#202124">
<div style="max-width:720px;margin:0 auto;padding:24px"><div style="background:#1A73E8;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-weight:600">${esc(title)}</div>
<div style="background:#fff;border:1px solid #DADCE0;border-top:0;border-radius:0 0 8px 8px;padding:18px">${body}</div>
<p style="color:#5F6368;font-size:12px">Palmonas Marketplace Operations · automated message</p></div></body></html>`;
}

interface DigestRow { id: string; name: string; channel: string; priority: number; status: string; deadline: string; timeliness: string; pendingFrom: string | null }

function table(rows: DigestRow[]) {
  if (!rows.length) return `<p style="color:#5F6368">None.</p>`;
  const th = (s: string) => `<th style="text-align:left;padding:6px;border-bottom:1px solid #DADCE0;font-size:12px;color:#5F6368">${s}</th>`;
  const td = (s: string) => `<td style="padding:6px;border-bottom:1px solid #F1F3F4;font-size:13px">${s}</td>`;
  return `<table style="width:100%;border-collapse:collapse"><tr>${["Task", "Channel", "Priority", "Status", "Deadline", "Timeliness", "Pending From"].map(th).join("")}</tr>${rows
    .map((r) => `<tr>${td(`<a href="${esc(taskLink(r.id))}">${esc(r.name)}</a><br><span style="color:#5F6368;font-size:11px">${esc(r.id)}</span>`)}${td(esc(r.channel))}${td(`P${r.priority}`)}${td(esc(r.status))}${td(esc(r.deadline))}${td(esc(r.timeliness))}${td(esc(r.pendingFrom ?? "—"))}</tr>`)
    .join("")}</table>`;
}

type Payload = Record<string, unknown>;

export function render(eventType: string, subject: string, payload: Payload): { html: string; text: string } {
  if (eventType === "MORNING_DIGEST_PERSONAL") {
    const p = payload as { date: string; dataAsOf: string; sections: { title: string; rows: DigestRow[] }[] };
    const body = `<p>Good morning. Here is your task position for <b>${esc(p.date)}</b> (data as of ${esc(p.dataAsOf)}).</p>${p.sections.map((s) => `<h3 style="font-size:15px;margin:18px 0 6px">${esc(s.title)} (${s.rows.length})</h3>${table(s.rows)}`).join("")}`;
    return { html: shell(subject, body), text: p.sections.map((s) => `${s.title}: ${s.rows.length}\n${s.rows.map((r) => `- ${r.name} (${r.id}) due ${r.deadline} ${taskLink(r.id)}`).join("\n")}`).join("\n\n") };
  }
  if (eventType === "EXECUTIVE_DIGEST") {
    const p = payload as { date: string; dataAsOf: string; kpis: Record<string, number>; workload: { name: string; active: number; overdue: number }[]; escalations: Record<string, number>; pending: Record<string, number>; projects: { name: string; pct: number | null; overdue: number }[]; changes: Record<string, number>; critical: DigestRow[] };
    const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `<li>${esc(k)}: <b>${v}</b></li>`).join("");
    const body = `<p>Executive summary for <b>${esc(p.date)}</b> · data as of ${esc(p.dataAsOf)}</p>
<h3>1. KPI summary</h3><ul>${kv(p.kpis)}</ul>
<h3>2. Team workload</h3><ul>${p.workload.map((w) => `<li>${esc(w.name)}: ${w.active} active, <b style="color:${w.overdue ? "#C5221F" : "#137333"}">${w.overdue} overdue</b></li>`).join("")}</ul>
<h3>3. Escalation radar</h3><ul>${kv(p.escalations)}</ul>${table(p.critical)}
<h3>4. Pending governance decisions</h3><ul>${kv(p.pending)}</ul>
<h3>5. Projects</h3><ul>${p.projects.map((x) => `<li>${esc(x.name)}: ${x.pct ?? "—"}% complete, ${x.overdue} overdue</li>`).join("") || "<li>None</li>"}</ul>
<h3>6. Changes in the last 24h</h3><ul>${kv(p.changes)}</ul>
<p><a href="${esc(base())}/">Open dashboard</a></p>`;
    return { html: shell(subject, body), text: `${subject}\n${JSON.stringify(p.kpis)}` };
  }
  const taskId = payload.taskId as string | undefined;
  const lines = Object.entries(payload).filter(([k]) => !["taskId"].includes(k) && payload[k] != null).map(([k, v]) => `<tr><td style="color:#5F6368;padding:4px 12px 4px 0">${esc(k)}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`).join("");
  const link = taskId ? `<p><a href="${esc(taskLink(taskId))}" style="background:#1A73E8;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open ${esc(taskId)}</a></p>` : "";
  return { html: shell(subject, `<table>${lines}</table>${link}`), text: `${subject}\n${JSON.stringify(payload)}${taskId ? `\n${taskLink(taskId)}` : ""}` };
}
