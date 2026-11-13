"use client";
import { useState } from "react";
import type { listBin } from "@/domain/deletion";
import { api, refreshAll, useApi } from "@/components/client";
import { Alert, Button, Card, EmptyState, fmtRelative, PageHeader, Skeleton } from "@/components/ui";
import { PriorityBadge, StatusBadge, TaskTitle } from "@/components/tasks/bits";
import { ActionModal, type ActionSpec } from "@/components/tasks/ActionModal";
import { toast } from "@/components/toast";

type Bin = Awaited<ReturnType<typeof listBin>>;
const LABEL: Record<string, string> = { subtasks: "subtasks", transfers: "transfers", extensions: "extension requests", waivers: "waivers", escalations: "escalations", cancellations: "drop/remove requests", accessGrants: "sharing entries", emailEvents: "queued emails" };

export default function BinPage() {
  const { data, error, isLoading, mutate } = useApi<Bin>("/bin");
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const restore = (r: Bin["rows"][number]) => setSpec({
    title: "Restore task", submitLabel: "Restore", description: `${r.name} (${r.id})`, intro: "It comes back with the same ID, owner, deadline and history.",
    fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
    run: async (v) => { const res = await api<{ warnings: string[] }>(`/tasks/${r.id}/restore`, { body: v }); await refreshAll(); toast.success("Task restored", res.warnings.join(" ")); },
  });
  const purge = (r: Bin["rows"][number]) => {
    const removed = Object.entries(r.purge.removed).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${LABEL[k] ?? k}`);
    setSpec({
      title: "Permanently purge?", submitLabel: "Purge permanently", danger: true, description: `${r.name} (${r.id})`,
      intro: <div className="space-y-2"><Alert>This can&apos;t be undone. The task{removed.length ? ` and its ${removed.join(", ")}` : ""} will be deleted.</Alert><p>Kept: the audit history ({r.purge.retained.auditEvents} entries) plus a record of this purge.</p></div>,
      fields: [
        { name: "reason", label: "Reason", type: "textarea", required: true },
        { name: "backupReference", label: "Backup reference", placeholder: "e.g. neon-branch-2026-11-13", hint: "Optional: the snapshot taken before purging." },
        { name: "confirmId", label: `Type ${r.id} to confirm`, required: true },
      ],
      run: async (v) => { await api(`/tasks/${r.id}/purge`, { body: v }); await refreshAll(); toast.success("Task purged"); },
    });
  };
  return (
    <div className="space-y-6">
      <PageHeader description="Tasks moved to the Bin. Restore brings a task back unchanged; purge deletes it permanently (Admin only)." />
      {error && <Alert action={<button className="font-semibold underline" onClick={() => mutate()}>Retry</button>}>{error.message}</Alert>}
      <Card>
        {isLoading && !data ? <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div> : !data?.rows.length ? <EmptyState icon="trash" title="The Recycle Bin is empty" /> : (
          <ul className="divide-y divide-slate-100">
            {data.rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <TaskTitle t={r} />
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500"><PriorityBadge p={r.priority} /><StatusBadge status={r.status} /><span>{r.owner.name} · {r.channel.name}</span></div>
                  <p className="mt-1 text-xs text-slate-500">Binned by {r.deletedByName ?? "—"} {fmtRelative(r.deletedAt)}{r.deletionReason ? `: ${r.deletionReason}` : ""}</p>
                </div>
                <div className="flex flex-none gap-2">
                  {data.canRestore && <Button size="sm" icon="restore" onClick={() => restore(r)}>Restore</Button>}
                  {data.canPurge && <Button size="sm" variant="danger" icon="trash" onClick={() => purge(r)}>Purge</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ActionModal spec={spec} onClose={() => setSpec(null)} />
    </div>
  );
}
