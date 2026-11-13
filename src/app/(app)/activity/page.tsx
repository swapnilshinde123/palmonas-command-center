"use client";
import { Suspense, useEffect, useState } from "react";
import { useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { useDebounced, useUrlState } from "@/components/useUrlState";
import { Alert, Card, cx, EmptyState, fmtDate, fmtRelative, Icon, PageHeader, Pagination, SearchInput, Segmented, Skeleton } from "@/components/ui";

interface Row { id: string; actorName: string; action: string; label: string; targetType: string; targetLabel: string; meta: Record<string, unknown> | null; createdAt: string }

function detail(r: Row) {
  const m = r.meta ?? {};
  if (r.action === "user.role_changed") return `${m.from} → ${m.to}`;
  if (r.action === "user.status_changed") return `${String(m.from).toLowerCase()} → ${String(m.to).toLowerCase()}${m.reason ? ` · “${m.reason}”` : ""}`;
  if (r.action === "user.updated" && Array.isArray(m.fields)) return `Changed ${(m.fields as string[]).join(", ")}`;
  if (r.action === "role.updated") return [Array.isArray(m.added) && m.added.length ? `+${(m.added as string[]).join(", ")}` : "", Array.isArray(m.removed) && m.removed.length ? `−${(m.removed as string[]).join(", ")}` : ""].filter(Boolean).join(" · ");
  if (m.role) return `Role: ${m.role}`;
  return "";
}

export default function ActivityPage() {
  return <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}><Activity /></Suspense>;
}

function Activity() {
  const { data: me, can } = useMe();
  const [f, set] = useUrlState(["q", "type", "page"] as const);
  const [q, setQ] = useState(f.q);
  const dq = useDebounced(q);
  useEffect(() => { if (dq !== f.q) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const { data, error, isLoading } = useApi<{ rows: Row[]; total: number; page: number; pageSize: number }>(can("activity.view") ? `/activity?${qs}` : null);
  if (me && !can("activity.view")) return <Card><EmptyState icon="lock" title="You don't have access to the activity log" /></Card>;
  return (
    <div>
      <PageHeader title="Activity log" description="An append-only record of sign-ins, account changes, invitations and role edits. Entries can't be edited or deleted." />
      <Card>
        <div className="flex flex-col gap-3 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <Segmented label="Type" value={f.type || "ALL"} onChange={(v) => set({ type: v === "ALL" ? null : v })} options={[{ value: "ALL", label: "All" }, { value: "USER", label: "Users" }, { value: "INVITATION", label: "Invitations" }, { value: "ROLE", label: "Roles" }, { value: "AUTH", label: "Sign-ins" }]} />
          <SearchInput value={q} onChange={setQ} placeholder="Search person or action" className="lg:w-72" />
        </div>
        {error && <div className="px-5"><Alert>{error.message}</Alert></div>}
        {isLoading && !data && <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
        {data?.rows.length === 0 && <EmptyState icon="activity" title="Nothing here yet" />}
        {data && data.rows.length > 0 && (
          <>
            <ol className="divide-y divide-slate-100 border-t border-slate-100">
              {data.rows.map((r) => (
                <li key={r.id} className="flex gap-3 px-4 py-3.5 sm:px-6">
                  <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-full", r.targetType === "INVITATION" ? "bg-amber-50 text-amber-600" : r.targetType === "ROLE" ? "bg-violet-50 text-violet-600" : r.targetType === "AUTH" ? (r.action === "auth.login" ? "bg-slate-100 text-slate-500" : "bg-red-50 text-red-600") : r.action === "user.deleted" ? "bg-red-50 text-red-600" : "bg-brand-soft text-brand")}>
                    <Icon name={r.targetType === "INVITATION" ? "mail" : r.targetType === "ROLE" ? "shield" : r.targetType === "AUTH" ? "key" : r.action === "user.deleted" ? "trash" : "user"} size={17} />
                  </span>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="text-slate-700"><b className="text-slate-900">{r.actorName}</b> {r.label} {r.targetLabel && <b className="text-slate-900">{r.targetLabel}</b>}</p>
                    {detail(r) && <p className="mt-0.5 truncate text-slate-500">{detail(r)}</p>}
                  </div>
                  <time dateTime={r.createdAt} title={fmtDate(r.createdAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} className="shrink-0 text-xs text-slate-500">{fmtRelative(r.createdAt)}</time>
                </li>
              ))}
            </ol>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>
    </div>
  );
}
