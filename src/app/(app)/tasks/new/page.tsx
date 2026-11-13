"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, newKey, refreshAll } from "@/components/client";
import { useMe } from "@/components/me";
import { useWorkspace } from "@/components/workspace";
import { Alert, Button, Card, cx, Field, Input, Select, Skeleton, Textarea } from "@/components/ui";
import { EMPTY_PENDING, PendingFromField, pendingPayload, validatePending, type PendingValue } from "@/components/tasks/PendingFromField";
import { toast } from "@/components/toast";

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export default function AddTaskPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const { ws, allow } = useWorkspace();
  const [f, setF] = useState({ name: "", channelId: "", ownerId: "", priority: "3", deadline: "", description: "", projectId: "", workstreamId: "", followupDate: "", outputLink: "", p0Justification: "", transferReason: "" });
  const [pending, setPending] = useState<PendingValue>(EMPTY_PENDING);
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  useEffect(() => { if (me && !f.ownerId) setF((x) => ({ ...x, ownerId: me.me.id })); }, [me, f.ownerId]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF((x) => ({ ...x, [k]: e.target.value })); setErrors((x) => ({ ...x, [k]: "" })); };
  const assignAny = allow("ASSIGN_ANY_OWNER");
  const forPeer = !!me && !!f.ownerId && f.ownerId !== me.me.id && !assignAny;
  const p0NeedsReason = f.priority === "0" && !allow("SET_P0_DIRECT");
  const activeProjects = useMemo(() => ws?.projects.filter((p) => p.status === "ACTIVE" || p.status === "ON_HOLD") ?? [], [ws]);

  function validate() {
    const e: Record<string, string> = { ...validatePending(pending) };
    if (f.name.trim().length < 3) e.name = "Give the task a name of at least 3 characters.";
    if (!f.channelId) e.channelId = "Pick a channel. Use General if it isn't marketplace-specific.";
    if (!f.ownerId) e.ownerId = "Pick an owner.";
    if (!f.deadline) e.deadline = "Pick a deadline.";
    else if (f.deadline < today()) e.deadline = "The deadline can't be in the past.";
    if (p0NeedsReason && !f.p0Justification.trim()) e.p0Justification = "Explain why this is P0.";
    if (f.outputLink && !/^https?:\/\//i.test(f.outputLink)) e.outputLink = "Links must start with https://";
    return e;
  }

  async function submit(another: boolean) {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) { setFormError("Some fields need attention."); if (e.pocType || e.pendingFrom) setMore(true); return; }
    setBusy(true); setFormError(null);
    try {
      const r = await api<{ result: { task: { id: string; name: string }; peerTransferPending: boolean } }>("/tasks", {
        idempotencyKey: another ? newKey() : key,
        body: { ...f, priority: Number(f.priority), projectId: f.projectId || null, workstreamId: f.workstreamId || null, followupDate: f.followupDate || null, outputLink: f.outputLink || null, ...pendingPayload(pending) },
      });
      await refreshAll();
      const t = r.result.task;
      toast.success("Task created", r.result.peerTransferPending ? `${t.id}. It stays with you until ${ws?.users.find((u) => u.id === f.ownerId)?.name} accepts the transfer.` : t.id);
      if (another) { setF((x) => ({ ...x, name: "", description: "", outputLink: "", p0Justification: "" })); setPending(EMPTY_PENDING); }
      else router.push(`/tasks/${encodeURIComponent(t.id)}`);
    } catch (err) {
      const a = err as ApiError;
      setErrors(a.fields ?? {});
      setFormError(a.message);
    } finally { setBusy(false); }
  }

  if (!ws || !me) return <Skeleton className="h-[520px] rounded-2xl" />;
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); submit(false); }} className="mx-auto max-w-3xl">
      <p className="mb-5 text-sm text-slate-500">Only the essentials are required. Everything else can be added later from the task.</p>
      <Card className="p-5 sm:p-7">
        <Field label="Task name" required error={errors.name}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} value={f.name} onChange={set("name")} placeholder="e.g. Fix suppressed hero SKUs on Amazon" autoFocus maxLength={300} />}</Field>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Channel" required error={errors.channelId}>{(id, d, inv) => <Select id={id} aria-describedby={d} invalid={inv} value={f.channelId} onChange={set("channelId")}><option value="">Select a channel</option>{ws.channels.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="Owner" required error={errors.ownerId} hint={forPeer ? "They'll get a transfer request. The task stays with you until they accept." : undefined}>
            {(id, d, inv) => <Select id={id} aria-describedby={d} invalid={inv} value={f.ownerId} onChange={set("ownerId")}>{ws.users.map((u) => <option key={u.id} value={u.id}>{u.id === me.me.id ? `${u.name} (me)` : u.name}</option>)}</Select>}
          </Field>
          <Field label="Priority" required error={errors.priority} hint="P0 is the most urgent.">
            {(id, d, inv) => (
              <div id={id} aria-describedby={d} role="radiogroup" aria-label="Priority" className="grid grid-cols-6 gap-1.5">
                {["0", "1", "2", "3", "4", "5"].map((p) => <button key={p} type="button" role="radio" aria-checked={f.priority === p} onClick={() => setF((x) => ({ ...x, priority: p }))} className={cx("h-11 rounded-xl border text-sm font-bold transition", f.priority === p ? (p === "0" ? "border-red-600 bg-red-600 text-white" : "border-brand bg-brand text-white") : inv ? "border-red-300" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>P{p}</button>)}
              </div>
            )}
          </Field>
          <Field label="Deadline" required error={errors.deadline} hint="Can only change later through an extension request.">{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="date" min={today()} value={f.deadline} onChange={set("deadline")} />}</Field>
        </div>
        {p0NeedsReason && <Field label="Why is this P0?" required error={errors.p0Justification}>{(id, d, inv) => <Textarea id={id} aria-describedby={d} invalid={inv} value={f.p0Justification} onChange={set("p0Justification")} placeholder="e.g. Hero SKU suppressed: direct revenue loss" />}</Field>}
        {forPeer && <Field label="Note to the new owner" optional>{(id) => <Input id={id} value={f.transferReason} onChange={set("transferReason")} placeholder="Why they should own it" />}</Field>}

        <PendingFromField value={pending} onChange={(v) => { setPending(v); setErrors((x) => ({ ...x, pocType: "", pendingFrom: "" })); }} errors={errors} />

        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className="mb-2 text-sm font-semibold text-brand hover:underline">{more ? "Hide" : "Show"} more details</button>
        {more && (
          <div className="animate-fade-up">
            <Field label="Description" optional>{(id) => <Textarea id={id} value={f.description} onChange={set("description")} maxLength={5000} />}</Field>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Field label="Project" optional>{(id) => <Select id={id} value={f.projectId} onChange={set("projectId")}><option value="">No project</option>{activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
              <Field label="Workstream" optional>{(id) => <Select id={id} value={f.workstreamId} onChange={set("workstreamId")}><option value="">None</option>{ws.workstreams.filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
              <Field label="Follow-up date" optional hint="When to chase the POC or check back. Shows in Due Soon.">{(id) => <Input id={id} type="date" value={f.followupDate} onChange={set("followupDate")} />}</Field>
              <Field label="Output link" optional error={errors.outputLink}>{(id, d, inv) => <Input id={id} aria-describedby={d} invalid={inv} type="url" value={f.outputLink} onChange={set("outputLink")} placeholder="https://" />}</Field>
            </div>
          </div>
        )}
        {formError && <Alert>{formError}</Alert>}
        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
          <Link href="/tasks" className="sm:mr-auto"><Button type="button" className="w-full">Cancel</Button></Link>
          <Button type="button" busy={busy} onClick={() => submit(true)}>Create &amp; add another</Button>
          <Button type="submit" variant="primary" busy={busy}>Create task</Button>
        </div>
      </Card>
    </form>
  );
}
