"use client";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import type { Task } from "@/components/workspace";
import { DeadlineText, LevelBadge, PocBadge, PriorityBadge, StatusBadge, TaskTitle } from "./bits";

// Read-mostly task list used by Due Soon, Pending From, Channels and Projects.
export function TaskTable<T extends Task>({ rows, extra, extraLabel, hideOwner }: { rows: T[]; extra?: (t: T) => ReactNode; extraLabel?: string; hideOwner?: boolean }) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
            <th scope="col" className="px-5 py-3">Task</th>{extra && <th scope="col" className="px-3 py-3">{extraLabel}</th>}<th scope="col" className="px-3 py-3">Priority</th><th scope="col" className="px-3 py-3">Status</th>
            <th scope="col" className="px-3 py-3">Channel</th>{!hideOwner && <th scope="col" className="px-3 py-3">Owner</th>}<th scope="col" className="px-3 py-3">Deadline</th><th scope="col" className="px-3 py-3">Follow-up</th><th scope="col" className="px-5 py-3">Esc.</th>
          </tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={cx("border-b border-slate-100 last:border-0 hover:bg-slate-50/60", t.timeliness === "OVERDUE" && "bg-red-50/30")}>
                <td className="max-w-[320px] px-5 py-3"><TaskTitle t={t} /></td>
                {extra && <td className="max-w-[240px] px-3 py-3">{extra(t)}</td>}
                <td className="px-3 py-3"><PriorityBadge p={t.priority} /></td>
                <td className="px-3 py-3"><StatusBadge status={t.status} /></td>
                <td className="px-3 py-3 text-slate-700">{t.channel.name}</td>
                {!hideOwner && <td className="px-3 py-3 text-slate-700">{t.owner.name}</td>}
                <td className="px-3 py-3"><DeadlineText t={t} /></td>
                <td className="px-3 py-3 text-sm tabular text-slate-600">{t.followupDate ?? "—"}</td>
                <td className="px-5 py-3"><LevelBadge level={t.escalationLevel} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-slate-100 md:hidden">
        {rows.map((t) => (
          <li key={t.id} className="p-4">
            <TaskTitle t={t} />
            {extra && <div className="mt-2">{extra(t)}</div>}
            <div className="mt-2 flex flex-wrap items-center gap-1.5"><PriorityBadge p={t.priority} /><StatusBadge status={t.status} /><LevelBadge level={t.escalationLevel} />{t.pocType && !extra && <PocBadge type={t.pocType} name={t.pendingFrom} compact />}</div>
            <p className="mt-2 text-xs text-slate-500">{t.channel.name}{!hideOwner && ` · ${t.owner.name}`} · <DeadlineText t={t} />{t.followupDate && ` · follow-up ${t.followupDate}`}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
