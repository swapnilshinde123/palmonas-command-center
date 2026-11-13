"use client";
import { useEffect, useState, type KeyboardEvent } from "react";
import { api, ApiError, refreshAll } from "../client";
import { Alert, Button, cx, Field, Icon, Modal, Select, Textarea } from "../ui";
import { useMe } from "../me";
import { toast } from "../toast";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface Result { sent: string[]; failed: { email: string; error?: string }[]; skipped: { email: string; reason: string }[]; links?: Record<string, string> }

export function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" icon={done ? "check" : "copy"} onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800); } catch { toast.error("Couldn't copy", "Select the link and copy it manually."); } }}>
      {done ? "Copied" : label}
    </Button>
  );
}

export function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useMe();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [roleId, setRoleId] = useState("");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // Reset only when the dialog opens: background revalidation of /me must not wipe the form or the result.
  useEffect(() => {
    if (!open) return;
    setEmails([]); setDraft(""); setMessage(""); setErrors({}); setResult(null); setRoleId("");
  }, [open]);
  useEffect(() => {
    if (open && !roleId && data) setRoleId(data.assignableRoles.find((r) => r.key === "member")?.id ?? data.assignableRoles.at(-1)?.id ?? "");
  }, [open, roleId, data]);

  const commit = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    setEmails((e) => [...new Set([...e, ...parts])].slice(0, 20));
    setDraft("");
    setErrors((x) => ({ ...x, emails: "" }));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (["Enter", ",", " ", "Tab"].includes(e.key) && draft.trim()) { e.preventDefault(); commit(draft); }
    if (e.key === "Backspace" && !draft && emails.length) setEmails((x) => x.slice(0, -1));
  };

  async function submit() {
    const all = [...new Set([...emails, ...draft.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)])];
    const e: Record<string, string> = {};
    if (!all.length) e.emails = "Add at least one email address.";
    const bad = all.filter((x) => !EMAIL_RE.test(x));
    if (bad.length) e.emails = `Check these addresses: ${bad.join(", ")}`;
    if (!roleId) e.roleId = "Pick the role they'll get.";
    if (message.length > 500) e.message = "Keep the message under 500 characters.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api<Result>("/invitations", { body: { emails: all, roleId, message } });
      await refreshAll();
      setEmails(all);
      setDraft("");
      if (r.sent.length) toast.success(`Invitation${r.sent.length > 1 ? "s" : ""} sent`, r.sent.join(", "));
      if (r.failed.length) toast.error("Some emails couldn't be delivered", "They're saved as pending. Resend from Invitations.");
      if (!r.links && !r.failed.length && !r.skipped.length) onClose();
      else setResult(r);
    } catch (err) {
      const a = err as ApiError;
      setErrors(a.fields ?? { form: a.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} busy={busy} title={result ? "Invitations sent" : "Invite people"}
      description={result ? undefined : "They'll get an email with a link to set up their account. Links expire after 7 days."}
      footer={result ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" icon="send" busy={busy} onClick={submit}>Send invitation{emails.length > 1 ? "s" : ""}</Button></>}>
      {result ? (
        <div className="space-y-3">
          {result.sent.length > 0 && <Alert tone="success">Sent to {result.sent.join(", ")}.</Alert>}
          {result.failed.length > 0 && <Alert tone="error">Email delivery failed for {result.failed.map((f) => f.email).join(", ")}. The invitation is saved; resend it from Invitations.</Alert>}
          {result.skipped.length > 0 && <Alert tone="warning"><b>Skipped:</b> {result.skipped.map((s) => `${s.email} (${s.reason})`).join("; ")}</Alert>}
          {result.links && (
            <div className="rounded-xl border border-slate-200 p-4">
              <p className="mb-1 text-sm font-bold">Email isn&apos;t configured on this server</p>
              <p className="mb-3 text-sm text-slate-500">The emails were saved to the outbox. Share these one-time links directly:</p>
              <ul className="space-y-2">
                {Object.entries(result.links).map(([em, link]) => (
                  <li key={em} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2.5 sm:flex-row sm:items-center">
                    <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{em}</span><span className="block truncate text-xs text-slate-500">{link}</span></span>
                    <CopyButton text={link} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          <Field label="Email addresses" required error={errors.emails} hint="Press Enter or comma after each address. Up to 20 at once.">
            {(id, d, invalid) => (
              <div className={cx("flex min-h-[48px] flex-wrap items-center gap-1.5 rounded-xl border bg-white px-2 py-1.5 focus-within:ring-4", invalid ? "border-red-400 focus-within:ring-red-100" : "border-slate-200 focus-within:border-brand focus-within:ring-brand-soft")}>
                {emails.map((e) => (
                  <span key={e} className={cx("inline-flex h-8 items-center gap-1 rounded-lg pl-2.5 pr-1 text-sm font-medium", EMAIL_RE.test(e) ? "bg-brand-soft text-blue-900" : "bg-red-50 text-red-700")}>
                    {e}
                    <button type="button" onClick={() => setEmails((x) => x.filter((y) => y !== e))} aria-label={`Remove ${e}`} className="grid h-6 w-6 place-items-center rounded-md hover:bg-white/70"><Icon name="x" size={14} /></button>
                  </span>
                ))}
                <input id={id} aria-describedby={d} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => draft.trim() && commit(draft)}
                  onPaste={(e) => { const t = e.clipboardData.getData("text"); if (/[\s,;]/.test(t)) { e.preventDefault(); commit(t); } }}
                  placeholder={emails.length ? "" : "name@example.com"} className="h-8 min-w-[160px] flex-1 border-0 bg-transparent px-1.5 text-sm focus:outline-none" type="email" autoComplete="off" />
              </div>
            )}
          </Field>
          <Field label="Role" required error={errors.roleId} hint={data?.assignableRoles.find((r) => r.id === roleId)?.description}>
            {(id, d, invalid) => (
              <Select id={id} aria-describedby={d} invalid={invalid} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">Select a role</option>
                {data?.assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Personal message" optional error={errors.message} hint={`${message.length}/500`}>
            {(id, d, invalid) => <Textarea id={id} aria-describedby={d} invalid={invalid} value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} placeholder="Welcome aboard! You'll track your marketplace tasks here." />}
          </Field>
          {errors.form && <Alert>{errors.form}</Alert>}
        </>
      )}
    </Modal>
  );
}
