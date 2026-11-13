"use client";
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
export { Icon, type IconName } from "./Icon";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- Buttons ----------
type Variant = "primary" | "secondary" | "danger" | "ghost" | "dark";
const variants: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover shadow-sm",
  secondary: "bg-white text-slate-800 border border-slate-200 hover:bg-slate-50",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
  ghost: "text-slate-700 hover:bg-slate-100",
  dark: "bg-navy text-white hover:bg-navy-800",
};

export function Button({ variant = "secondary", size = "md", busy, icon, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean; icon?: IconName }) {
  return (
    <button {...p} disabled={p.disabled || busy} aria-busy={busy || undefined}
      className={cx("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition active:scale-[.98] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-9 px-3 text-[13px]" : "h-11 px-4 text-sm", variants[variant], className)}>
      {busy ? <Spinner className="h-4 w-4" /> : icon && <Icon name={icon} size={size === "sm" ? 16 : 18} />}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, badge, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; badge?: number }) {
  return (
    <button {...p} aria-label={label} title={label}
      className={cx("relative grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 active:scale-95", className)}>
      <Icon name={icon} size={20} />
      {!!badge && <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white ring-2 ring-white tabular">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );
}

export const Spinner = ({ className = "h-5 w-5" }: { className?: string }) => (
  <span role="status" aria-label="Loading" className={cx("inline-block animate-spin rounded-full border-2 border-current border-r-transparent", className)} />
);

// ---------- Form fields ----------
export function Field({ label, error, hint, required, optional, children, className }: { label: string; error?: string; hint?: ReactNode; required?: boolean; optional?: boolean; className?: string; children: (id: string, describedBy: string | undefined, invalid: boolean) => ReactNode }) {
  const id = useId();
  const d = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className={cx("mb-4", className)}>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1 text-[13px] font-semibold text-slate-700">
        {label}{required && <span className="text-red-600" aria-hidden>*</span>}{optional && <span className="font-normal text-slate-400">(optional)</span>}
      </label>
      {children(id, d, !!error)}
      {error ? <p id={d} role="alert" className="mt-1.5 flex items-start gap-1 text-[13px] font-medium text-red-600"><Icon name="alert" size={15} className="mt-px" />{error}</p>
        : hint && <p id={d} className="mt-1.5 text-[13px] text-slate-500">{hint}</p>}
    </div>
  );
}

const control = (invalid?: boolean) => cx("w-full rounded-xl border bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 transition focus:outline-none focus:ring-4",
  invalid ? "border-red-400 focus:border-red-500 focus:ring-red-100" : "border-slate-200 focus:border-brand focus:ring-brand-soft", "disabled:bg-slate-50 disabled:text-slate-500");
export const Input = ({ invalid, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) => <input {...p} aria-invalid={invalid || undefined} className={cx(control(invalid), "h-11", className)} />;
export const Select = ({ invalid, className, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) => (
  <div className="relative">
    <select {...p} aria-invalid={invalid || undefined} className={cx(control(invalid), "h-11 appearance-none pr-10", className)} />
    <Icon name="chevronDown" size={16} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
  </div>
);
export const Textarea = ({ invalid, className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) => <textarea {...p} aria-invalid={invalid || undefined} className={cx(control(invalid), "min-h-[96px] py-2.5", className)} />;

export function PasswordInput(p: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...p} type={show ? "text" : "password"} className="pr-11" />
      <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-slate-500 hover:bg-slate-100">
        <Icon name={show ? "eyeOff" : "eye"} size={17} />
      </button>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, className, label = "Search" }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; label?: string }) {
  return (
    <div className={cx("relative", className)}>
      <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input type="search" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cx(control(), "h-11 pl-10")} />
    </div>
  );
}

// ---------- Overlays ----------
function useLockScroll(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [on]);
}

export function Modal({ open, onClose, title, description, children, footer, size = "md", busy }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg"; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLockScroll(open);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), select, textarea, button:not([data-close])")?.focus(), 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>("a,button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex='-1'])")];
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1)!.focus(); }
        else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [open, onClose, busy]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/50 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title"
        className={cx("flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-pop animate-sheet-up sm:rounded-2xl sm:animate-scale-in", size === "sm" ? "sm:max-w-md" : size === "lg" ? "sm:max-w-3xl" : "sm:max-w-xl")}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 pb-4 pt-5 sm:px-6">
          <div><h2 id="modal-title" className="text-lg font-bold text-slate-900">{title}</h2>{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>
          <button data-close onClick={onClose} disabled={busy} aria-label="Close" className="-mr-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><Icon name="x" size={18} /></button>
        </div>
        <div className="overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer && <div className="flex flex-col-reverse gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel, tone = "danger", onConfirm, onClose, typeToConfirm, children }: {
  open: boolean; title: string; body: ReactNode; confirmLabel: string; tone?: "danger" | "primary"; onConfirm: (typed: string) => Promise<unknown>; onClose: () => void; typeToConfirm?: string; children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setTyped(""); setErr(null); } }, [open]);
  const ok = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.toLowerCase();
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" busy={busy}
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} busy={busy} disabled={!ok}
          onClick={async () => { setBusy(true); setErr(null); try { await onConfirm(typed); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>{confirmLabel}</Button>
      </>}>
      <div className="flex gap-3">
        <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-full", tone === "danger" ? "bg-red-50 text-red-600" : "bg-brand-soft text-brand")}><Icon name={tone === "danger" ? "alert" : "info"} size={20} /></span>
        <div className="text-sm text-slate-600">{body}</div>
      </div>
      {children}
      {typeToConfirm && (
        <div className="mt-4">
          <Field label={`Type ${typeToConfirm} to confirm`}>{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
        </div>
      )}
      {err && <Alert tone="error">{err}</Alert>}
    </Modal>
  );
}

export function Menu({ label, items, align = "right" }: { label: string; align?: "left" | "right"; items: ({ label: string; icon: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string } | null)[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = items.filter(Boolean) as NonNullable<(typeof items)[number]>[];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); ref.current?.querySelector<HTMLElement>("button")?.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const els = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus(), 0);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [open]);
  if (!list.length) return null;
  return (
    <div ref={ref} className="relative inline-block">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={label} className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Icon name="more" size={20} /></button>
      {open && (
        <div role="menu" className={cx("absolute z-40 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop animate-scale-in", align === "right" ? "right-0" : "left-0")}>
          {list.map((it) => (
            <button key={it.label} role="menuitem" disabled={it.disabled} title={it.hint} onClick={() => { setOpen(false); it.onSelect(); }}
              className={cx("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium focus:outline-none disabled:opacity-40", it.danger ? "text-red-600 hover:bg-red-50 focus:bg-red-50" : "text-slate-700 hover:bg-slate-50 focus:bg-slate-100")}>
              <Icon name={it.icon} size={17} />{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Display ----------
type Tone = "green" | "amber" | "red" | "slate" | "blue" | "violet";
const tones: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/15",
  slate: "bg-slate-100 text-slate-700 ring-slate-500/15",
  blue: "bg-brand-soft text-brand-hover ring-brand/15",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/15",
};
export function Badge({ tone = "slate", children, dot, icon }: { tone?: Tone; children: ReactNode; dot?: boolean; icon?: IconName }) {
  return (
    <span className={cx("inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset", tones[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}{icon && <Icon name={icon} size={13} />}{children}
    </span>
  );
}

export const USER_STATUS: Record<string, { label: string; tone: Tone }> = { ACTIVE: { label: "Active", tone: "green" }, SUSPENDED: { label: "Suspended", tone: "amber" }, DEACTIVATED: { label: "Deactivated", tone: "slate" } };
export const INVITE_STATUS: Record<string, { label: string; tone: Tone; icon: IconName }> = {
  PENDING: { label: "Pending", tone: "blue", icon: "clock" }, ACCEPTED: { label: "Accepted", tone: "green", icon: "check" },
  EXPIRED: { label: "Expired", tone: "amber", icon: "alert" }, REVOKED: { label: "Revoked", tone: "slate", icon: "ban" },
};

const AVATAR = ["bg-amber-200 text-amber-900", "bg-sky-200 text-sky-900", "bg-lime-200 text-lime-900", "bg-violet-200 text-violet-900", "bg-rose-200 text-rose-900", "bg-teal-200 text-teal-900"];
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "?";
export function Avatar({ name, size = 40, className }: { name: string; size?: number; className?: string }) {
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-full font-bold", AVATAR[h % AVATAR.length], className)} style={{ width: size, height: size, fontSize: size * 0.36 }}>{initials(name)}</span>;
}

export function Card({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={cx("rounded-2xl border border-slate-200/70 bg-white shadow-card", className)}>{children}</As>;
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
      <div><h2 className="text-lg font-bold text-slate-900">{title}</h2>{subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}</div>
      {action}
    </div>
  );
}

// The page title is the top bar's <h1>; this row carries the page intro and primary actions.
export function PageHeader({ description, actions }: { title?: string; description?: string; actions?: ReactNode }) {
  if (!description && !actions) return null;
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      {description ? <p className="max-w-2xl text-[15px] text-slate-500">{description}</p> : <span />}
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon = "inbox", title, body, action }: { icon?: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500"><Icon name={icon} size={26} /></span>
      <p className="font-bold text-slate-900">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-slate-500">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({ tone = "error", children, action }: { tone?: "error" | "success" | "info" | "warning"; children: ReactNode; action?: ReactNode }) {
  const t = { error: "bg-red-50 text-red-800 border-red-200", success: "bg-emerald-50 text-emerald-800 border-emerald-200", info: "bg-brand-soft text-blue-900 border-blue-200", warning: "bg-amber-50 text-amber-900 border-amber-200" }[tone];
  const icon: IconName = tone === "error" ? "alert" : tone === "success" ? "checkCircle" : tone === "warning" ? "alert" : "info";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("mt-4 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm", t)}>
      <Icon name={icon} size={18} className="mt-px" /><div className="flex-1">{children}</div>{action}
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cx("animate-pulse rounded-lg bg-slate-200/70", className)} aria-hidden />;

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-sm text-slate-500 sm:flex-row sm:px-6">
      <span className="tabular">Showing <b className="text-slate-800">{from}–{Math.min(total, page * pageSize)}</b> of <b className="text-slate-800">{total}</b></span>
      <div className="flex items-center gap-2">
        <Button size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">Prev</Button>
        <span className="tabular">Page {page} of {pages}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">Next<Icon name="chevronRight" size={16} /></Button>
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 scrollbar-thin">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cx("flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-sm font-semibold transition", value === o.value ? "bg-white text-brand shadow-sm" : "text-slate-600 hover:text-slate-900")}>
          {o.label}{o.count !== undefined && <span className={cx("rounded-md px-1.5 text-xs tabular", value === o.value ? "bg-brand-soft" : "bg-slate-200/70")}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export const fmtDate = (d: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) => (d ? new Date(d).toLocaleDateString("en-GB", opts) : "—");
export function fmtRelative(d: string | Date | null | undefined) {
  if (!d) return "Never";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const fut = s < 0;
  const a = Math.abs(s);
  const [v, u] = a < 60 ? [a, "sec"] : a < 3600 ? [Math.floor(a / 60), "min"] : a < 86400 ? [Math.floor(a / 3600), "hr"] : a < 86400 * 30 ? [Math.floor(a / 86400), "day"] : [0, ""];
  if (!u) return fmtDate(d);
  if (a < 30) return "Just now";
  const unit = u === "day" && v !== 1 ? "days" : u;
  return fut ? `in ${v} ${unit}` : `${v} ${unit} ago`;
}
