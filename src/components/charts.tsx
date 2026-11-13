"use client";
import { cx } from "./ui";

export function BarChart({ data, height = 220, highlightMax = true, label }: { data: { label: string; value: number }[]; height?: number; highlightMax?: boolean; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <figure aria-label={label} className="w-full">
      <div className="flex items-end gap-1.5 sm:gap-2.5" style={{ height }}>
        {data.map((d) => {
          const h = (d.value / max) * (height - 28);
          const top = highlightMax && d.value === max && d.value > 0;
          return (
            <div key={d.label} className="group flex h-full flex-1 flex-col items-center justify-end">
              <span className={cx("mb-1.5 text-xs font-bold tabular", top ? "text-brand" : "text-slate-500")}>{d.value}</span>
              <div title={`${d.label}: ${d.value}`} className={cx("w-full max-w-[44px] rounded-t-lg transition-[height] duration-700 ease-out", top ? "bg-brand" : "bg-blue-400/80 group-hover:bg-brand/80")} style={{ height: Math.max(h, d.value ? 6 : 2) }} />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1.5 border-t border-slate-200 pt-2 sm:gap-2.5" aria-hidden>
        {data.map((d) => <span key={d.label} className="flex-1 text-center text-xs font-semibold text-slate-500 tabular">{d.label}</span>)}
      </div>
      <table className="sr-only"><caption>{label}</caption><tbody>{data.map((d) => <tr key={d.label}><th>{d.label}</th><td>{d.value}</td></tr>)}</tbody></table>
    </figure>
  );
}

export function Donut({ value, size = 170, stroke = 16, children, color = "#2563EB" }: { value: number | null; size?: number; stroke?: number; children?: React.ReactNode; color?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} className="transition-[stroke-dasharray] duration-700 ease-out" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

// Multi-segment ring for status breakdowns.
export function SegmentRing({ segments, size = 150, stroke = 18, center }: { segments: { label: string; value: number; color: string }[]; size?: number; stroke?: number; center?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0);
  let off = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={stroke} />
        {total > 0 && segments.map((s) => {
          const len = (s.value / total) * c;
          const el = <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke} strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-off} />;
          off += len;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{center}</div>
    </div>
  );
}
