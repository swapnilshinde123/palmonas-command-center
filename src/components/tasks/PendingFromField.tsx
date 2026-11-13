"use client";
import { useEffect, useState } from "react";
import { useApi } from "@/components/client";
import { useDebounced } from "@/components/useUrlState";
import { cx, Field, Input, Icon } from "@/components/ui";
import { POC_LABEL, type PocType } from "@/components/workspace";

export interface PendingValue { pending: boolean; pocType: PocType | ""; pocId: string; pendingFrom: string }
export const EMPTY_PENDING: PendingValue = { pending: false, pocType: "", pocId: "", pendingFrom: "" };
type Poc = { id: string; name: string; type: PocType; organisation: string };

// Brief §6 progressive disclosure: optional until "waiting on someone" is ticked; then POC Type
// and POC Name are both required. Pick a saved POC, or type a new name (kept on this task only).
export function PendingFromField({ value, onChange, errors }: { value: PendingValue; onChange: (v: PendingValue) => void; errors: Record<string, string | undefined> }) {
  const { data: registry } = useApi<Poc[]>(value.pending && value.pocType ? `/pocs?type=${value.pocType}` : null);
  const [query, setQuery] = useState(value.pendingFrom);
  const dq = useDebounced(query, 250);
  useEffect(() => setQuery(value.pendingFrom), [value.pendingFrom]);
  const { data: similar } = useApi<Poc[]>(value.pending && !value.pocId && dq.trim().length >= 3 ? `/pocs/suggest?name=${encodeURIComponent(dq)}&type=${value.pocType}` : null);
  const matches = (registry ?? []).filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  const chosen = registry?.find((p) => p.id === value.pocId);
  const set = (p: Partial<PendingValue>) => onChange({ ...value, ...p });

  return (
    <fieldset className="mb-4 rounded-2xl border border-slate-200 p-4">
      <legend className="sr-only">Pending From</legend>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-0.5 h-5 w-5 rounded border-slate-300 accent-[#2563EB]" checked={value.pending} onChange={(e) => onChange(e.target.checked ? { ...value, pending: true } : EMPTY_PENDING)} />
        <span><span className="block text-sm font-semibold text-slate-800">Waiting on someone (Pending From)</span><span className="block text-xs text-slate-500">Tick this if the task is blocked on a person or team. It then shows on the Pending From page. This doesn&apos;t escalate the task.</span></span>
      </label>
      {value.pending && (
        <div className="mt-4 animate-fade-up">
          <p className="mb-1.5 text-[13px] font-semibold text-slate-700">POC Type <span className="text-red-600" aria-hidden>*</span></p>
          <div role="radiogroup" aria-label="POC Type" className="mb-1 grid grid-cols-3 gap-2">
            {(["I", "WB", "E"] as PocType[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={value.pocType === t} onClick={() => set({ pocType: t, pocId: "" })}
                className={cx("h-11 rounded-xl border text-sm font-semibold transition", value.pocType === t ? "border-brand bg-brand-soft text-brand" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>{POC_LABEL[t]}</button>
            ))}
          </div>
          {errors.pocType && <p role="alert" className="mb-2 text-[13px] font-medium text-red-600">{errors.pocType}</p>}
          <Field label="POC Name" required error={errors.pendingFrom} className="mt-3"
            hint={!value.pocType ? "Pick a POC Type first." : chosen ? `Saved POC${chosen.organisation ? ` · ${chosen.organisation}` : ""}` : query.trim() ? "Not in the saved list: it will be kept on this task only. L1 can add it to the saved list later." : "Search saved POCs or type a new name."}>
            {(id, d, inv) => (
              <div className="relative">
                <Input id={id} aria-describedby={d} invalid={inv} disabled={!value.pocType} value={chosen ? chosen.name : query} placeholder="e.g. Amazon Seller Support" autoComplete="off"
                  onChange={(e) => { setQuery(e.target.value); set({ pocId: "", pendingFrom: e.target.value }); }} />
                {chosen && <button type="button" aria-label="Clear POC" onClick={() => { setQuery(""); set({ pocId: "", pendingFrom: "" }); }} className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"><Icon name="x" size={16} /></button>}
              </div>
            )}
          </Field>
          {value.pocType && !chosen && matches.length > 0 && (
            <div className="-mt-2 mb-2">
              <p className="mb-1.5 text-xs font-semibold text-slate-500">Saved {POC_LABEL[value.pocType as PocType]} POCs</p>
              <div className="flex flex-wrap gap-1.5">
                {matches.map((p) => <button key={p.id} type="button" onClick={() => { setQuery(p.name); set({ pocId: p.id, pendingFrom: p.name }); }} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand">{p.name}</button>)}
              </div>
            </div>
          )}
          {!chosen && similar && similar.length > 0 && similar.some((p) => p.name.toLowerCase() !== query.trim().toLowerCase()) && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900"><b>Possible duplicate:</b> {similar.map((p) => `${p.name} (${POC_LABEL[p.type]})`).join(", ")}. Pick it above if it&apos;s the same person.</p>
          )}
        </div>
      )}
    </fieldset>
  );
}

export const pendingPayload = (v: PendingValue) => (v.pending ? { pocType: v.pocType || null, ...(v.pocId ? { pocId: v.pocId, pendingFrom: null } : { pocId: null, pendingFrom: v.pendingFrom.trim() || null }) } : { pocType: null, pocId: null, pendingFrom: null });

export function validatePending(v: PendingValue) {
  const e: Record<string, string> = {};
  if (!v.pending) return e;
  if (!v.pocType) e.pocType = "Pick a POC Type: Internal, Within Brand or External.";
  if (!v.pocId && !v.pendingFrom.trim()) e.pendingFrom = "POC Name is required when the task is pending.";
  return e;
}
