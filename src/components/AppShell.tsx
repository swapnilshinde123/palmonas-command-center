"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { mutate as globalMutate } from "swr";
import { Avatar, cx, fmtRelative, Icon, IconButton, type IconName } from "./ui";
import { api, startLive, useApi } from "./client";
import { useWorkspace, type Workspace } from "./workspace";
import { useMe } from "./me";
import type { Permission } from "@/domain/permissions";

type NavItem = { href: string; label: string; icon: IconName; perm?: Permission; show?: (w: Workspace | undefined) => boolean; badge?: "approvals" };
const NAV: { section: string; items: NavItem[] }[] = [
  { section: "Workspace", items: [
    { href: "/", label: "Command Center", icon: "grid" },
    { href: "/tasks", label: "My Tasks", icon: "tasks" },
    { href: "/tasks/new", label: "Add Task", icon: "plus" },
    { href: "/due", label: "Due Soon", icon: "clock" },
    { href: "/pending", label: "Pending From", icon: "hourglass" },
    { href: "/escalations", label: "Escalations", icon: "flame" },
    { href: "/approvals", label: "Approvals", icon: "approve" },
  ] },
  { section: "Organise", items: [
    { href: "/projects", label: "Projects", icon: "folder" },
    { href: "/channels", label: "Channels", icon: "store" },
    { href: "/recurring", label: "Recurring", icon: "repeat" },
    { href: "/kpi", label: "KPI Scoreboard", icon: "gauge" },
    { href: "/bin", label: "Recycle Bin", icon: "trash", show: (w) => !!w?.privileged },
  ] },
  { section: "Team", items: [
    { href: "/users", label: "Team members", icon: "users", perm: "users.view" },
    { href: "/invitations", label: "Invitations", icon: "mail", perm: "invitations.view" },
    { href: "/roles", label: "Roles & permissions", icon: "shield", perm: "roles.view" },
  ] },
  { section: "Admin", items: [
    { href: "/settings", label: "Settings", icon: "settings", perm: "settings.manage" },
    { href: "/activity", label: "Activity log", icon: "activity", perm: "activity.view" },
    { href: "/emails", label: "Email outbox", icon: "inbox", perm: "emails.view" },
  ] },
];

const TITLES: [RegExp, string][] = [
  [/^\/$/, "Command Center"], [/^\/tasks\/new/, "Add Task"], [/^\/tasks\/./, "Task"], [/^\/tasks/, "Tasks"], [/^\/due/, "Due Soon & Follow-ups"],
  [/^\/pending/, "Pending From"], [/^\/escalations/, "Escalations"], [/^\/approvals/, "Approvals"], [/^\/projects/, "Projects"], [/^\/channels/, "Channels"],
  [/^\/recurring/, "Recurring tasks"], [/^\/kpi/, "KPI Scoreboard"], [/^\/bin/, "Recycle Bin"], [/^\/settings/, "Settings"],
  [/^\/users/, "Team members"], [/^\/invitations/, "Invitations"], [/^\/roles/, "Roles & permissions"], [/^\/activity/, "Activity log"], [/^\/emails/, "Email outbox"], [/^\/profile/, "My profile"],
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { can } = useMe();
  const { ws } = useWorkspace();
  const isActive = (it: NavItem) => {
    if (it.href === "/") return path === "/";
    if (it.href === "/tasks") return path === "/tasks" || (path.startsWith("/tasks/") && path !== "/tasks/new");
    return path.startsWith(it.href);
  };
  return (
    <nav aria-label="Main" className="flex h-full flex-col px-4 pb-6 pt-6">
      <Link href="/" onClick={onNavigate} className="mb-7 flex items-center gap-3 px-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-navy text-lime-accent"><Icon name="bolt" size={22} /></span>
        <span className="leading-tight"><span className="block text-[20px] font-extrabold tracking-tight text-slate-900">Palmonas</span><span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">Ops Command</span></span>
      </Link>
      <div className="flex-1 space-y-6 overflow-y-auto scrollbar-thin">
        {NAV.map((g) => {
          const items = g.items.filter((i) => (!i.perm || can(i.perm)) && (!i.show || i.show(ws)));
          if (!items.length) return null;
          return (
            <div key={g.section}>
              <p className="mb-2 px-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">{g.section}</p>
              <ul className="space-y-0.5">
                {items.map((it) => {
                  const active = isActive(it);
                  return (
                    <li key={it.href}>
                      <Link href={it.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
                        className={cx("flex h-10 items-center gap-3 rounded-xl px-3 text-[14.5px] font-semibold transition", active ? "bg-brand-soft text-brand" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900")}>
                        <Icon name={it.icon} size={19} />
                        <span className="flex-1">{it.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <Link href="/profile" onClick={onNavigate} className={cx("mt-4 flex h-10 items-center gap-3 rounded-xl px-3 text-[14.5px] font-semibold", path === "/profile" ? "bg-brand-soft text-brand" : "text-slate-600 hover:bg-slate-50")}>
        <Icon name="user" size={19} />My profile
      </Link>
    </nav>
  );
}

function UserMenu() {
  const { data } = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const c = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", c);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", c); document.removeEventListener("keydown", k); };
  }, [open]);
  if (!data) return <div className="h-11 w-11 animate-pulse rounded-xl bg-slate-200 sm:w-48" />;
  const me = data.me;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex h-11 items-center gap-2.5 rounded-xl border border-slate-200 bg-white pl-1.5 pr-1.5 hover:bg-slate-50 sm:pr-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-xs font-bold text-white">{me.name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
        <span className="hidden max-w-[140px] truncate text-sm font-bold sm:block">{me.name}</span>
        <Icon name="chevronDown" size={16} className="hidden text-slate-500 sm:block" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-64 rounded-2xl border border-slate-200 bg-white p-2 shadow-pop animate-scale-in">
          <div className="flex items-center gap-3 border-b border-slate-100 px-2 pb-3 pt-1">
            <Avatar name={me.name} size={40} />
            <div className="min-w-0"><p className="truncate text-sm font-bold">{me.name}</p><p className="truncate text-xs text-slate-500">{me.email}</p><p className="mt-0.5 text-xs font-semibold text-brand">{me.role.name}{me.escalationLevel ? ` · ${me.escalationLevel} escalation owner` : ""}</p></div>
          </div>
          <Link role="menuitem" href="/profile" onClick={() => setOpen(false)} className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Icon name="user" size={17} />My profile</Link>
          <button role="menuitem" onClick={() => signOut({ callbackUrl: "/login" })} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"><Icon name="logout" size={17} />Sign out</button>
        </div>
      )}
    </div>
  );
}

type Bell = { rows: { id: string; eventType: string; title: string; body: string; taskId: string | null; read: boolean; createdAt: string }[]; unread: number };

function Notifications() {
  const router = useRouter();
  const { data, mutate } = useApi<Bell>("/notifications", { refreshInterval: 120000 });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const c = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", c);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", c); document.removeEventListener("keydown", k); };
  }, [open]);
  const unread = data?.unread ?? 0;
  const openItem = async (n: Bell["rows"][number]) => {
    setOpen(false);
    if (!n.read) await api("/notifications", { body: { ids: [n.id] } }).catch(() => undefined);
    void mutate();
    if (n.taskId) router.push(`/tasks/${encodeURIComponent(n.taskId)}`);
  };
  return (
    <div ref={ref} className="relative">
      <IconButton icon="bell" label={`Notifications${unread ? `, ${unread} unread` : ""}`} badge={unread} aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white p-2 shadow-pop animate-scale-in">
          <div className="flex items-center justify-between px-3 pb-2 pt-1">
            <p className="text-sm font-bold">Notifications</p>
            {unread > 0 && <button className="text-xs font-semibold text-brand hover:underline" onClick={async () => { await api("/notifications", { body: { all: true } }); void mutate(); }}>Mark all read</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto scrollbar-thin">
            {!data && <div className="space-y-2 p-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-100" />)}</div>}
            {data && data.rows.length === 0 && <p className="px-3 py-8 text-center text-sm text-slate-500">You&apos;re all caught up.</p>}
            {data?.rows.map((n) => (
              <button key={n.id} onClick={() => openItem(n)} className={cx("flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-slate-50", !n.read && "bg-brand-soft/60")}>
                <span className={cx("mt-1.5 h-2 w-2 flex-none rounded-full", n.read ? "bg-transparent" : "bg-brand")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cx("block", !n.read && "font-semibold")}>{n.title}</span>
                  {n.body && <span className="mt-0.5 block truncate text-xs text-slate-500">{n.body}</span>}
                  <span className="mt-0.5 block text-xs text-slate-400">{fmtRelative(n.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LiveDot({ state }: { state: "live" | "reconnecting" | "off" }) {
  const label = state === "live" ? "Live: updates appear automatically" : state === "reconnecting" ? "Reconnecting…" : "Connecting…";
  return (
    <span title={label} aria-live="polite" className="hidden items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 sm:inline-flex">
      <span className={cx("h-2 w-2 rounded-full", state === "live" ? "animate-pulse bg-emerald-500" : "bg-amber-400")} />
      {state === "live" ? "Live" : "Connecting"}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const [q, setQ] = useState("");
  const title = TITLES.find(([re]) => re.test(path))?.[1] ?? "Palmonas";
  const [live, setLive] = useState<"live" | "reconnecting" | "off">("off");
  useEffect(() => setDrawer(false), [path]);
  useEffect(() => startLive(setLive, () => void globalMutate("/notifications")), []);

  return (
    <div className="min-h-screen lg:pl-72">
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-slate-200/80 bg-white lg:block"><Sidebar /></aside>
      {drawer && (
        <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-[86%] max-w-xs bg-white shadow-pop animate-slide-in">
            <button onClick={() => setDrawer(false)} aria-label="Close navigation" className="absolute right-3 top-5 grid h-10 w-10 place-items-center rounded-xl text-slate-500 hover:bg-slate-100"><Icon name="x" size={20} /></button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-[76px] max-w-[1440px] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <button onClick={() => setDrawer(true)} aria-label="Open navigation" className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-white lg:hidden"><Icon name="menu" size={20} /></button>
          <h1 className="min-w-0 flex-1 truncate text-xl font-extrabold tracking-tight sm:text-[28px]">{title}</h1>
          <form role="search" className="relative hidden md:block" onSubmit={(e) => { e.preventDefault(); router.push(`/tasks?view=all&q=${encodeURIComponent(q)}`); }}>
            <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} type="search" aria-label="Search tasks" placeholder="Search tasks or IDs…" className="h-11 w-56 rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-sm focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand-soft xl:w-72" />
          </form>
          <LiveDot state={live} />
          <Notifications />
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
