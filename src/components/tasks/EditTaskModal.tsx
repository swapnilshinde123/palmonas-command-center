"use client";
import { useState } from "react";
import type { getTaskDetail } from "@/domain/tasks";
import { api, ApiError, refreshAll } from "@/components/client";
import { useWorkspace, type PocType } from "@/components/workspace";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { PendingFromField, pendingPayload, validatePending, type PendingValue } from "./PendingFromField";
import { toast } from "@/components/toast";

type Detail = Awaited<ReturnType<typeof getTaskDetail>>;

// Sends only the fields that changed, with the version the user started from, so a concurrent
// edit by someone else comes back as STALE instead of being overwritten.
export function EditTaskModal({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const t = detail.task;
  const can = detail.permissions;
  const { ws } = useWorkspace();
  const start = {
    name: t.name, description: t.description, channelId: t.channel.id, projectId: t.project?.id ?? "", workstreamId: t.workstream?.id ?? "",
    priority: String(t.priority), followupDate: t.followupDate ?? "", remarks: t.remarks ?? "", outputLink: t.outputLink ?? "", deadline: t.deadline ?? "",
  };
  const startPending: PendingValue = { pending: !!t.pocType, pocType: (t.pocType ?? "") as PocType | "", pocId: t.poc?.isRegistry ? t.poc.id : "", pendingFrom: t.pendingFrom ?? "" };
  const [f, setF] = useState(start);
  const [pending, setPending] = useState(startPending);
  const [reason, setReason] = useState("");
  const [version, setVersion] = useState(t.version);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof start) => (e: { target: { value: string } }) => { setF((x) => ({ ...x, [k]: e.target.value })); setErrors((x) => ({ ...x, [k]: "" })); };
  const p0Reason = f.priority === "0" && t.priority !== 0 && !can.priorityP0Direct;
  const deadlineChanged = f.deadline !== start.deadline;

  async function save() {
    const patch: Record<string, unknown> = {};
    if (f.name !== start.name) patch.name = f.name;
    if (f.description !== start.description) patch.description = f.description;
    if (f.channelId !== start.channelId) patch.channelId = f.channelId;
    if (f.projectId !== start.projectId) patch.projectId = f.projectId || null;
    if (f.workstreamId !== start.workstreamId) patch.workstreamId = f.workstreamId || null;
    if (f.priority !== start.priority) patch.priority = Number(f.priority);
    if (f.followupDate !== start.followupDate) patch.followupDate = f.followupDate || null;
    if (f.remarks !== start.remarks) patch.remarks = f.remarks || null;
    if (f.outputLink !== start.outputLink) patch.outputLink = f.outputLink || null;
    if (deadlineChanged) patch.deadline = f.deadline;
    if (JSON.stringify(pending) !== JSON.stringify(startPending)) Object.assign(patch, pendingPayload(pending));
    const e: Record<string, string> = { ...validatePending(pending) };
    if (f.name.trim().length < 3) e.name = "Use at least 3 characters.";
    if ((p0Reason || deadlineChanged) && !reason.trim()) e.reason = deadlineChanged ? "A reason is required to correct the deadline." : "P0 needs a written justification.";
    setErrors(e);
    if (Object.keys(e).length) return;
    if (!Object.keys(patch).length) return onClose();
    setBusy(true); setFormError(null);
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: { expectedVersion: version, patch, reason: reason || null } });
      await refreshAll();
      toast.success("Task updated");
      onClose();
    } catch (err) {
      const a = err as ApiError;
      if (a.code === "STALE") {
        setVersion((a.details as { version: number }).version);
        setFormError("Someone else changed this task while you were editing. Your edits are kept here; check the task and save again to apply them on top.");
      } else { setErrors(a.fields ?? {}); setFormError(a.fields ? null : a.message); }
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} busy={busy} size="lg" title="Edit task" description={t.id}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save changes</Button></>}>
      <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Task name" required error={errors.name}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} value={f.name} onChange={set("name")} />}</Field>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Channel" error={errors.channelId}>{(id) => <Select id={id} value={f.channelId} onChange={set("channelId")}>{ws?.channels.filter((c) => c.active || c.id === start.channelId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="Priority" error={errors.priority}>{(id) => <Select id={id} value={f.priority} onChange={set("priority")}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>P{i}</option>)}</Select>}</Field>
          <Field label="Project" optional error={errors.projectId}>{(id) => <Select id={id} value={f.projectId} onChange={set("projectId")}><option value="">No project</option>{ws?.projects.filter((p) => p.status === "ACTIVE" || p.status === "ON_HOLD" || p.id === start.projectId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
          <Field label="Workstream" optional>{(id) => <Select id={id} value={f.workstreamId} onChange={set("workstreamId")}><option value="">None</option>{ws?.workstreams.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
          <Field label="Follow-up date" optional error={errors.followupDate}>{(id) => <Input id={id} type="date" value={f.followupDate} onChange={set("followupDate")} />}</Field>
          <Field label="Deadline" error={errors.deadline} hint={can.deadlineCorrection ? "Admin correction only (e.g. a typo). To extend, use an extension request." : "Change it through an extension request."}>
            {(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="date" value={f.deadline} onChange={set("deadline")} disabled={!can.deadlineCorrection} />}
          </Field>
        </div>
        {(p0Reason || deadlineChanged) && <Field label={deadlineChanged ? "Reason for the correction" : "Why is this P0?"} required error={errors.reason}>{(id, d, inv) => <Textarea id={id} aria-describedby={d} invalid={inv} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
        <PendingFromField value={pending} onChange={setPending} errors={errors} />
        <Field label="Description" optional>{(id) => <Textarea id={id} value={f.description} onChange={set("description")} />}</Field>
        <Field label="Remarks" optional>{(id) => <Textarea id={id} value={f.remarks} onChange={set("remarks")} />}</Field>
        <Field label="Output link" optional error={errors.outputLink}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="url" value={f.outputLink} onChange={set("outputLink")} placeholder="https://" />}</Field>
        {formError && <Alert tone={formError.startsWith("Someone") ? "warning" : "error"}>{formError}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
