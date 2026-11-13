"use client";
import { useEffect, useState } from "react";
import { api, ApiError, refreshAll } from "@/components/client";
import { Button, Field, Modal, Textarea } from "@/components/ui";
import { toast } from "@/components/toast";
import type { Task } from "@/components/workspace";

// Admin/Leadership soft-delete directly; members file a removal request for approval (governance).
export function BinModal({ task, privileged, onClose, onDone }: { task: Pick<Task, "id" | "name"> | null; privileged: boolean; onClose: () => void; onDone?: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(""); setErr(null); }, [task?.id]);
  if (!task) return null;
  const submit = async () => {
    if (!reason.trim()) return setErr("Say why, so the change is clear in the history.");
    setBusy(true);
    try {
      if (privileged) await api(`/tasks/${task.id}/delete`, { body: { reason } });
      else await api(`/tasks/${task.id}/cancellation`, { body: { kind: "DELETE", reason } });
      await refreshAll();
      toast.success(privileged ? "Moved to Recycle Bin" : "Removal requested", privileged ? "Restore it from the Recycle Bin if needed." : "Admin or Leadership will review it.");
      onClose(); onDone?.();
    } catch (e) { setErr((e as ApiError).fields?.reason ?? (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} busy={busy} title={privileged ? "Move to Recycle Bin?" : "Request removal?"} description={<>{task.name} <span className="text-slate-400">({task.id})</span></>}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" busy={busy} onClick={submit}>{privileged ? "Move to Bin" : "Send request"}</Button></>}>
      <p className="mb-4 text-sm text-slate-600">{privileged ? "The task leaves every list but keeps its ID and history. It can be restored." : "Only Admin or Leadership can bin tasks. Your request goes to them for a decision."}</p>
      <Field label="Reason" required error={err ?? undefined}>{(id, d, inv) => <Textarea id={id} aria-describedby={d} invalid={inv} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />}</Field>
    </Modal>
  );
}
