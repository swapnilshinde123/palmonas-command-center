"use client";
import { useEffect, useState } from "react";
import { Icon } from "./ui/Icon";

type Toast = { id: number; title: string; body?: string; tone: "success" | "error" | "info" };
const listeners = new Set<(t: Toast) => void>();
let n = 0;

export const toast = {
  success: (title: string, body?: string) => emit({ id: ++n, title, body, tone: "success" }),
  error: (title: string, body?: string) => emit({ id: ++n, title, body, tone: "error" }),
  info: (title: string, body?: string) => emit({ id: ++n, title, body, tone: "info" }),
};
function emit(t: Toast) {
  listeners.forEach((l) => l(t));
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const l = (t: Toast) => {
      setItems((x) => [...x.slice(-3), t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), t.tone === "error" ? 8000 : 4500);
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-5 sm:items-end" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-pop animate-fade-up">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${t.tone === "success" ? "bg-emerald-50 text-emerald-600" : t.tone === "error" ? "bg-red-50 text-red-600" : "bg-brand-soft text-brand"}`}>
            <Icon name={t.tone === "success" ? "check" : t.tone === "error" ? "alert" : "info"} size={17} />
          </span>
          <div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-900">{t.title}</p>{t.body && <p className="mt-0.5 break-words text-sm text-slate-500">{t.body}</p>}</div>
          <button onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} aria-label="Dismiss" className="-m-1 grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100"><Icon name="x" size={15} /></button>
        </div>
      ))}
    </div>
  );
}
