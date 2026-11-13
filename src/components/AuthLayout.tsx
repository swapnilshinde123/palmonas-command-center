import type { ReactNode } from "react";
import { Icon } from "./ui/Icon";

export function AuthLayout({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <aside className="relative hidden overflow-hidden bg-navy p-12 text-white lg:flex lg:flex-col">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-white/10 text-lime-accent"><Icon name="bolt" size={24} /></span><span className="text-2xl font-extrabold">Palmonas</span></div>
        <div className="mt-auto max-w-md">
          <p className="text-4xl font-extrabold leading-tight">Every marketplace task, owner and deadline in one place.</p>
          <p className="mt-4 text-white/70">See what's due, what's pending from whom, and what needs escalating. Live for everyone on the team.</p>
        </div>
        <div aria-hidden className="pointer-events-none absolute -bottom-24 -right-24 h-80 w-80 rounded-full border-[28px] border-white/[.05]" />
        <div aria-hidden className="pointer-events-none absolute right-24 top-24 h-24 w-24 rounded-full bg-lime-accent/90" />
      </aside>
      <main className="flex items-center justify-center p-5 sm:p-10">
        <div className="w-full max-w-md animate-fade-up">
          <div className="mb-8 flex items-center gap-3 lg:hidden"><span className="grid h-10 w-10 place-items-center rounded-full bg-navy text-lime-accent"><Icon name="bolt" size={22} /></span><span className="text-xl font-extrabold">Palmonas</span></div>
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
          {subtitle && <div className="mt-2 text-slate-500">{subtitle}</div>}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
