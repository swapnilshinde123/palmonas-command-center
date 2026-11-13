"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { ApiError } from "@/components/client";
import { Alert, Button, cx, Field, Input, Modal, Select, Textarea } from "@/components/ui";

export type FieldDef = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "date" | "select" | "checkbox" | "radio";
  options?: { value: string; label: string; hint?: string }[];
  required?: boolean;
  hint?: string;
  placeholder?: string;
  min?: string;
  showIf?: (v: Values) => boolean;
};
export type Values = Record<string, string | boolean>;
export type ActionSpec = {
  title: string;
  description?: ReactNode;
  intro?: ReactNode;
  fields: FieldDef[];
  submitLabel: string;
  danger?: boolean;
  initial?: Values;
  run: (v: Values) => Promise<unknown>;
};

// One modal for every "decide / request with a reason" action: client-side required checks first,
// server field errors mapped back, and the user's input kept when the server refuses.
export function ActionModal({ spec, onClose, onDone }: { spec: ActionSpec | null; onClose: () => void; onDone?: () => void }) {
  const [v, setV] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!spec) return;
    setV(spec.initial ?? {}); setErrors({}); setFormError(null);
  }, [spec]);
  if (!spec) return null;
  const visible = spec.fields.filter((f) => !f.showIf || f.showIf(v));
  const set = (k: string, val: string | boolean) => { setV((x) => ({ ...x, [k]: val })); setErrors((x) => ({ ...x, [k]: "" })); };

  async function submit() {
    const e: Record<string, string> = {};
    for (const f of visible) {
      const val = v[f.name];
      if (f.required && (f.type === "checkbox" ? val !== true : !String(val ?? "").trim())) e[f.name] = f.type === "checkbox" ? "Tick this to continue." : `${f.label} is required.`;
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFormError(null);
    try {
      await spec!.run(v);
      onClose(); onDone?.();
    } catch (err) {
      const a = err as ApiError;
      const known = Object.fromEntries(Object.entries(a.fields ?? {}).filter(([k]) => visible.some((f) => f.name === k)));
      setErrors(known);
      setFormError(Object.keys(known).length ? null : a.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} busy={busy} title={spec.title} description={spec.description}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant={spec.danger ? "danger" : "primary"} busy={busy} onClick={submit}>{spec.submitLabel}</Button></>}>
      <form noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {spec.intro && <div className="mb-4 text-sm text-slate-600">{spec.intro}</div>}
        {visible.map((f) => {
          if (f.type === "checkbox") return (
            <div key={f.name} className="mb-4">
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3">
                <input type="checkbox" className="mt-0.5 h-5 w-5 rounded border-slate-300 accent-[#2563EB]" checked={v[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} />
                <span className="text-sm"><span className="block font-semibold text-slate-800">{f.label}</span>{f.hint && <span className="block text-slate-500">{f.hint}</span>}</span>
              </label>
              {errors[f.name] && <p role="alert" className="mt-1.5 text-[13px] font-medium text-red-600">{errors[f.name]}</p>}
            </div>
          );
          if (f.type === "radio") return (
            <div key={f.name} className="mb-4">
              <p className="mb-1.5 text-[13px] font-semibold text-slate-700">{f.label}{f.required && <span className="text-red-600"> *</span>}</p>
              <div role="radiogroup" aria-label={f.label} className="grid gap-2 sm:grid-cols-3">
                {f.options?.map((o) => (
                  <button key={o.value} type="button" role="radio" aria-checked={v[f.name] === o.value} onClick={() => set(f.name, o.value)}
                    className={cx("rounded-xl border p-3 text-left transition", v[f.name] === o.value ? "border-brand bg-brand-soft ring-2 ring-brand/20" : "border-slate-200 bg-white hover:bg-slate-50")}>
                    <span className="block text-sm font-bold">{o.label}</span>{o.hint && <span className="block text-xs text-slate-500">{o.hint}</span>}
                  </button>
                ))}
              </div>
              {errors[f.name] ? <p role="alert" className="mt-1.5 text-[13px] font-medium text-red-600">{errors[f.name]}</p> : f.hint && <p className="mt-1.5 text-[13px] text-slate-500">{f.hint}</p>}
            </div>
          );
          return (
            <Field key={f.name} label={f.label} required={f.required} optional={!f.required} error={errors[f.name]} hint={f.hint}>
              {(id, d, inv) => f.type === "textarea" ? <Textarea id={id} aria-describedby={d} invalid={inv} value={String(v[f.name] ?? "")} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} maxLength={1000} />
                : f.type === "select" ? <Select id={id} aria-describedby={d} invalid={inv} value={String(v[f.name] ?? "")} onChange={(e) => set(f.name, e.target.value)}><option value="">Select…</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                : <Input id={id} aria-describedby={d} invalid={inv} type={f.type === "date" ? "date" : "text"} min={f.min} value={String(v[f.name] ?? "")} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />}
            </Field>
          );
        })}
        {formError && <Alert>{formError}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
