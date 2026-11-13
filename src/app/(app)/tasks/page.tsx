"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { api, refreshAll, useApi } from "@/components/client";
import { useDebounced, useUrlState } from "@/components/useUrlState";
import { useWorkspace, POC_LABEL, type PocType, type Task } from "@/components/workspace";
import { Alert, Button, Card, cx, EmptyState, Menu, PageHeader, SearchInput, Segmented, Select, Skeleton } from "@/components/ui";
import { DeadlineText, LevelBadge, PocBadge, PriorityBadge, StatusBadge, TaskTitle } from "@/components/tasks/bits";
import { toast } from "@/components/toast";
import { useMe } from "@/components/me";
import { BinModal } from "@/components/tasks/BinModal";

export default function TasksPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Tasks /></Suspense>;
}

const KEYS = ["view", "q", "status", "priority", "channelId", "ownerId", "projectId", "pocType", "flagged", "starred", "due", "scope"] as const;

function Tasks() {
  const { ws } = useWorkspace();
  const { data: me } = useMe();
  const [f, set] = useUrlState(KEYS);
  const [q, setQ] = useState(f.q);
  const dq = useDebounced(q);
  useEffect(() => { if (dq !== f.q) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setQ(f.q), [f.q]);
  const view = f.view || "mine";
  const qs = new URLSearchParams(Object.entries({ ...f, view }).filter(([, v]) => v) as [string, string][]).toString();
  const { data, error, isLoading, mutate } = useApi<Task[]>(ws ? `/tasks?${qs}` : null);
  const [binTask, setBinTask] = useState<Task | null>(null);
  const filtered = !!(f.q || f.status || f.priority || f.channelId || f.ownerId || f.projectId || f.pocType || f.flagged || f.starred || f.due || f.scope);
  const priv = !!ws?.privileged;

  const views = [{ value: "mine", label: "My tasks" }, { value: "shared", label: "Shared with me" }, ...(priv ? [{ value: "team", label: "All team" }] : [])];
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); await refreshAll(); toast.success(ok); } catch (e) { toast.error("Couldn't update the task", (e as Error).message); }
  };
  // Row actions: Flag, then Move to Bin, as the brief orders them.
  const actions = (t: Task) => [
    { label: "Open task", icon: "arrowRight" as const, onSelect: () => (window.location.href = `/tasks/${encodeURIComponent(t.id)}`) },
    priv || t.owner.id === me?.me.id ? { label: t.flagged ? "Remove flag" : "Flag", icon: "flag" as const, onSelect: () => act(() => api(`/tasks/${t.id}/flag`, { body: { flagged: !t.flagged } }), t.flagged ? "Flag removed" : "Task flagged") } : null,
    { label: priv ? "Move to Bin" : "Request removal", icon: "trash" as const, danger: true, onSelect: () => setBinTask(t) },
    priv ? { label: t.starred ? "Unstar" : "Star", icon: "star" as const, onSelect: () => act(() => api(`/tasks/${t.id}/star`, { body: { starred: !t.starred } }), t.starred ? "Unstarred" : "Starred") } : null,
  ];

  return (
    <div>
      <PageHeader description={view === "mine" ? "Your tasks. Admin and Leadership can switch to the whole team." : view === "shared" ? "Tasks owned by others that you're involved in." : "Every task across the team."}
        actions={<Link href="/tasks/new"><Button variant="primary" icon="plus">Add task</Button></Link>} />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Segmented label="Task view" value={view} onChange={(v) => set({ view: v === "mine" ? null : v, ownerId: null })} options={views} />
        <Segmented label="Status scope" value={f.scope || "active"} onChange={(v) => set({ scope: v === "active" ? null : v })} options={[{ value: "active", label: "Open" }, { value: "completed", label: "Completed" }, { value: "dropped", label: "Dropped" }, { value: "all", label: "All" }]} />
      </div>
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:p-5">
          <div className="flex flex-col gap-3">
            <SearchInput value={q} onChange={setQ} placeholder="Search name, ID or POC" className="md:max-w-md" label="Search tasks" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Select aria-label="Channel" value={f.channelId} onChange={(e) => set({ channelId: e.target.value || null })}><option value="">All channels</option>{ws?.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              <Select aria-label="Priority" value={f.priority} onChange={(e) => set({ priority: e.target.value || null })}><option value="">Any priority</option>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>P{i}</option>)}</Select>
              <Select aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value || null })}><option value="">Any status</option><option value="NOT_STARTED">Not started</option><option value="IN_PROGRESS">In progress</option><option value="ON_HOLD">On hold</option><option value="COMPLETED">Completed</option><option value="DROPPED">Dropped</option></Select>
              <Select aria-label="Pending From" value={f.pocType} onChange={(e) => set({ pocType: e.target.value || null })}><option value="">Pending: any</option><option value="any">Pending on someone</option>{(["I", "WB", "E"] as PocType[]).map((t) => <option key={t} value={t}>{POC_LABEL[t]}</option>)}</Select>
              <Select aria-label="Project" value={f.projectId} onChange={(e) => set({ projectId: e.target.value || null })}><option value="">All projects</option>{ws?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
              {view === "team" ? <Select aria-label="Owner" value={f.ownerId} onChange={(e) => set({ ownerId: e.target.value || null })}><option value="">All owners</option>{ws?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
                : <Select aria-label="Due" value={f.due} onChange={(e) => set({ due: e.target.value || null })}><option value="">Any date</option><option value="soon">Due / follow-up soon</option><option value="overdue">Overdue</option></Select>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip on={f.flagged === "true"} onClick={() => set({ flagged: f.flagged ? null : "true" })} icon="flag">Flagged</Chip>
            {priv && <Chip on={f.starred === "true"} onClick={() => set({ starred: f.starred ? null : "true" })} icon="star">Starred</Chip>}
            {view === "team" && <Chip on={f.due === "overdue"} onClick={() => set({ due: f.due === "overdue" ? null : "overdue" })} icon="alert">Overdue</Chip>}
            {filtered && <button className="ml-auto text-sm font-semibold text-brand hover:underline" onClick={() => set(Object.fromEntries(KEYS.filter((k) => k !== "view").map((k) => [k, null])))}>Clear filters</button>}
          </div>
        </div>
        {error && <div className="p-4"><Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert></div>}
        {isLoading && !data && <div className="space-y-2 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
        {data && data.length === 0 && (
          <EmptyState icon="tasks" title={filtered ? "No tasks match these filters" : view === "shared" ? "Nothing shared with you" : "No open tasks"}
            body={filtered ? "Try clearing a filter." : view === "mine" ? "Add a task to start tracking it." : undefined}
            action={!filtered && view === "mine" ? <Link href="/tasks/new"><Button variant="primary" icon="plus">Add task</Button></Link> : undefined} />
        )}
        {data && data.length > 0 && (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-5 py-3">Task</th><th scope="col" className="px-3 py-3">Priority</th><th scope="col" className="px-3 py-3">Status</th><th scope="col" className="px-3 py-3">Channel</th>
                  <th scope="col" className="px-3 py-3">Owner</th><th scope="col" className="px-3 py-3">Deadline</th><th scope="col" className="px-3 py-3">Pending From</th><th scope="col" className="px-3 py-3">Esc.</th><th scope="col" className="px-3 py-3"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {data.map((t) => (
                    <tr key={t.id} className={cx("border-b border-slate-100 last:border-0 hover:bg-slate-50/60", t.timeliness === "OVERDUE" && "bg-red-50/30")}>
                      <td className="max-w-[340px] px-5 py-3"><TaskTitle t={t} /></td>
                      <td className="px-3 py-3"><PriorityBadge p={t.priority} /></td>
                      <td className="px-3 py-3"><StatusBadge status={t.status} /></td>
                      <td className="px-3 py-3 text-slate-700">{t.channel.name}</td>
                      <td className="px-3 py-3 text-slate-700">{t.owner.name}</td>
                      <td className="px-3 py-3"><DeadlineText t={t} />{t.followupDate && <span className="block text-xs text-violet-700">Follow-up {t.followupDate.slice(5)}</span>}</td>
                      <td className="max-w-[200px] px-3 py-3">{t.pocType ? <PocBadge type={t.pocType} name={t.pendingFrom} compact /> : <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-3"><LevelBadge level={t.escalationLevel} /></td>
                      <td className="px-3 py-3 text-right"><Menu label={`Actions for ${t.name}`} items={actions(t)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {data.map((t) => (
                <li key={t.id} className="flex gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <TaskTitle t={t} />
                    <div className="mt-2 flex flex-wrap items-center gap-1.5"><PriorityBadge p={t.priority} /><StatusBadge status={t.status} /><LevelBadge level={t.escalationLevel} />{t.pocType && <PocBadge type={t.pocType} name={t.pendingFrom} compact />}</div>
                    <p className="mt-2 text-xs text-slate-500">{t.channel.name} · {t.owner.name} · <DeadlineText t={t} /></p>
                  </div>
                  <Menu label={`Actions for ${t.name}`} items={actions(t)} />
                </li>
              ))}
            </ul>
            <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">{data.length} task{data.length === 1 ? "" : "s"}</p>
          </>
        )}
      </Card>
      <BinModal task={binTask} privileged={priv} onClose={() => setBinTask(null)} />
    </div>
  );
}

function Chip({ on, onClick, icon, children }: { on: boolean; onClick: () => void; icon: "flag" | "star" | "alert"; children: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition", on ? "border-brand bg-brand-soft text-brand" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden><path d={icon === "flag" ? "M4 22V4M4 4h13l-2 4 2 4H4" : icon === "star" ? "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2z" : "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"} /></svg>
      {children}
    </button>
  );
}

