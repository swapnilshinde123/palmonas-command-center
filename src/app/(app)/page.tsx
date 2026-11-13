"use client";
import Link from "next/link";
import { useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { Alert, Button, Card, CardHeader, cx, EmptyState, fmtRelative, Icon, Skeleton, type IconName } from "@/components/ui";
import { EVENT_LABEL } from "@/components/tasks/bits";

type Bucket = { key: string; label: string; active: number; overdue: number; dueSoon: number; onHold: number; completedThisMonth: number; total: number };
type CC = {
  asOf: string; drilldown: boolean; totals: Bucket; owners: Bucket[]; channels: Bucket[]; priorities: Bucket[];
  my: { active: number; dueSoon: number; followupSoon: number; pendingFrom: number; escalations: number; approvals: number };
  recent: { id: string; taskId: string; task: string; eventType: string; actorName: string; at: string; reason: string | null }[];
};

function Stat({ label, value, icon, href, tone = "blue", hint }: { label: string; value: number; icon: IconName; href: string; tone?: "blue" | "red" | "amber" | "violet" | "green"; hint?: string }) {
  const t = { blue: "bg-brand-soft text-brand", red: "bg-red-50 text-red-600", amber: "bg-amber-50 text-amber-700", violet: "bg-violet-50 text-violet-700", green: "bg-emerald-50 text-emerald-700" }[tone];
  return (
    <Link href={href} className="group rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:border-brand/30 sm:p-5">
      <div className="flex items-center justify-between">
        <span className={cx("grid h-10 w-10 place-items-center rounded-xl", t)}><Icon name={icon} size={20} /></span>
        <Icon name="arrowRight" size={16} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand" />
      </div>
      <p className="mt-4 text-3xl font-extrabold tabular">{value}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-600">{label}</p>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </Link>
  );
}

// One row per owner/channel/priority: a stacked bar of overdue / due soon / other active work.
function BreakdownTable({ title, subtitle, rows, link, drill, compact }: { title: string; subtitle: string; rows: Bucket[]; link: (b: Bucket) => string; drill: boolean; compact?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.active));
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} subtitle={subtitle} />
      {rows.length === 0 ? <EmptyState icon="tasks" title="Nothing here yet" body="Counts appear once tasks exist." /> : (
        <div className="overflow-x-auto">
          <table className={cx("w-full text-sm", compact ? "min-w-[420px]" : "min-w-[560px]")}>
            <thead><tr className="border-y border-slate-100 bg-slate-50/60 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-5 py-2.5">{title.replace(/^By /, "")}</th><th scope="col" className="px-3 py-2.5">Active</th><th scope="col" className={cx("px-3 py-2.5", compact ? "w-[28%]" : "w-[38%]")}><span className="sr-only">Distribution</span></th>
              <th scope="col" className="px-3 py-2.5 text-right">Overdue</th><th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right">Due soon</th><th scope="col" className="px-5 py-2.5 text-right">{compact ? "Done (mo.)" : "Done this month"}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const other = Math.max(0, r.active - r.overdue - r.dueSoon);
                const name = drill ? <Link href={link(r)} className="font-semibold text-slate-900 hover:text-brand">{r.label}</Link> : <span className="font-semibold text-slate-900">{r.label}</span>;
                return (
                  <tr key={r.key} className="border-b border-slate-100 last:border-0">
                    <th scope="row" className="px-5 py-3 text-left">{name}</th>
                    <td className="px-3 py-3 font-bold tabular">{r.active}</td>
                    <td className="px-3 py-3">
                      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100" style={{ width: `${Math.max(6, (r.active / max) * 100)}%` }} aria-hidden>
                        <span className="bg-red-500" style={{ flex: r.overdue }} /><span className="bg-amber-400" style={{ flex: r.dueSoon }} /><span className="bg-brand/70" style={{ flex: other }} />
                      </div>
                    </td>
                    <td className={cx("px-3 py-3 text-right tabular", r.overdue ? "font-bold text-red-600" : "text-slate-400")}>{r.overdue}</td>
                    <td className={cx("px-3 py-3 text-right tabular", r.dueSoon ? "font-semibold text-amber-700" : "text-slate-400")}>{r.dueSoon}</td>
                    <td className="px-5 py-3 text-right tabular text-slate-600">{r.completedThisMonth}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function CommandCenter() {
  const { data: me } = useMe();
  const { data, error, isLoading, mutate } = useApi<CC>("/command");
  const first = me?.me.name.split(/\s+/)[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">{first ? `${greet}, ${first}` : " "}</h2>
          <p className="text-sm text-slate-500">Team status at a glance. {data && <>Updated {fmtRelative(data.asOf)}.</>}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/tasks/new"><Button variant="primary" icon="plus">Add task</Button></Link>
          <Link href="/due"><Button icon="clock">Due soon</Button></Link>
          <Link href="/pending"><Button icon="hourglass">Pending From</Button></Link>
        </div>
      </div>

      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}

      <section aria-label="Your work">
        {isLoading && !data ? <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div> : data && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="My active tasks" value={data.my.active} icon="tasks" href="/tasks" />
            <Stat label="Due soon" value={data.my.dueSoon} icon="clock" href="/due" tone="amber" hint="Includes overdue" />
            <Stat label="Follow-ups due" value={data.my.followupSoon} icon="calendar" href="/due" tone="violet" />
            <Stat label="Pending From" value={data.my.pendingFrom} icon="hourglass" href="/pending?view=mine" tone="blue" />
            <Stat label="Escalations" value={data.my.escalations} icon="flame" href="/escalations" tone="red" hint="Yours or assigned to you" />
            <Stat label={data.drilldown ? "Awaiting decision" : "Transfers to accept"} value={data.my.approvals} icon="approve" href="/approvals" tone="green" />
          </div>
        )}
      </section>

      {data && (
        <section aria-label="Team totals" className="grid grid-cols-2 gap-4 rounded-2xl bg-navy p-5 text-white sm:grid-cols-4 sm:p-6">
          {[["Active tasks", data.totals.active], ["Overdue", data.totals.overdue], ["Due soon", data.totals.dueSoon], ["Completed this month", data.totals.completedThisMonth]].map(([l, v]) => (
            <div key={l as string}><p className="text-3xl font-extrabold tabular">{v}</p><p className="text-sm text-white/70">{l}</p></div>
          ))}
          {!data.drilldown && <p className="col-span-2 text-xs text-white/60 sm:col-span-4">Team counts are a read-only summary. Task details open only for work you own or are involved in.</p>}
        </section>
      )}

      {isLoading && !data && <Skeleton className="h-80 rounded-2xl" />}
      {data && (
        <>
          <BreakdownTable title="By owner" subtitle="Active work per person, with what's overdue or due soon." rows={data.owners} drill={data.drilldown} link={(b) => `/tasks?view=team&ownerId=${b.key}`} />
          <div className="grid gap-6 xl:grid-cols-2">
            <BreakdownTable title="By channel" subtitle="Marketplace load." rows={data.channels} compact drill={data.drilldown} link={(b) => `/tasks?view=team&channelId=${b.key}`} />
            <BreakdownTable title="By priority" subtitle="P0 is the most urgent." rows={data.priorities} compact drill={data.drilldown} link={(b) => `/tasks?view=team&priority=${b.key}`} />
          </div>
          <Card>
            <CardHeader title="Recent activity" subtitle="Changes on tasks you can see." />
            {data.recent.length === 0 ? <EmptyState icon="activity" title="No activity yet" /> : (
              <ul className="divide-y divide-slate-100">
                {data.recent.map((r) => (
                  <li key={r.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                    <span className="mt-0.5 grid h-8 w-8 flex-none place-items-center rounded-lg bg-slate-100 text-slate-500"><Icon name="history" size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <p><b>{r.actorName}</b> {EVENT_LABEL[r.eventType] ?? r.eventType.toLowerCase().replace(/_/g, " ")} · <Link href={`/tasks/${encodeURIComponent(r.taskId)}`} className="font-semibold text-brand hover:underline">{r.task}</Link></p>
                      {r.reason && <p className="truncate text-xs text-slate-500">{r.reason}</p>}
                    </div>
                    <span className="flex-none text-xs text-slate-400">{fmtRelative(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
