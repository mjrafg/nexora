"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Home, Building2, Bot, LayoutGrid, FolderKanban, Video, CheckSquare, ShieldCheck,
  BookOpen, BarChart3, Plug, Settings, Sparkles, Wrench, CreditCard, KeyRound, BellRing,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCompanyNow } from "@/lib/use-company-now";

type NavItem = { label: string; icon: typeof Home; href: string; count?: number; live?: boolean; attention?: boolean };

const nav: NavItem[] = [
  { label: "Needs You", icon: BellRing, href: "/action-center", attention: true },
  { label: "Home", icon: Home, href: "/" },
  { label: "Company", icon: Building2, href: "/company" },
  { label: "Agents", icon: Bot, href: "/agents" },
  { label: "Departments", icon: LayoutGrid, href: "/#departments" },
  { label: "Projects", icon: FolderKanban, href: "/projects" },
  { label: "Capabilities", icon: Wrench, href: "/capabilities" },
  { label: "Payments", icon: CreditCard, href: "/payments" },
  { label: "Credentials", icon: KeyRound, href: "/credentials" },
  { label: "Meetings", icon: Video, href: "/#meetings" },
  { label: "Work", icon: CheckSquare, href: "/work" },
  { label: "Approvals", icon: ShieldCheck, href: "/payments/requests" },
  { label: "Knowledge", icon: BookOpen, href: "/#knowledge" },
  { label: "Analytics", icon: BarChart3, href: "/#analytics" },
  { label: "Integrations", icon: Plug, href: "/settings/mcp" },
  { label: "Settings", icon: Settings, href: "/settings/providers" },
];

/**
 * Unresolved owner actions, live. The same stream drives the badge and — when
 * the owner has allowed notifications — the browser's own notification, so a
 * blocking action reaches them even on another tab.
 */
function useOwnerActionCount() {
  const [counts, setCounts] = useState({ total: 0, blocking: 0 });
  useEffect(() => {
    let alive = true;
    const load = () => { void fetch("/api/action-center").then((r) => r.json()).then((d) => { if (alive && d?.counts) setCounts(d.counts); }).catch(() => undefined); };
    load();
    const es = new EventSource("/api/action-center/events");
    es.onmessage = (m) => {
      load();
      try {
        const detail = JSON.parse(JSON.parse(m.data).detail ?? "{}") as { event?: string; title?: string; body?: string; href?: string };
        if (detail.event === "notify" && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
          const n = new Notification(detail.title ?? "Nexora", { body: detail.body, tag: detail.href, icon: "/favicon.ico" });
          n.onclick = () => { window.focus(); if (detail.href) window.location.href = detail.href; };
        }
      } catch { /* not a notification event */ }
    };
    const poll = setInterval(load, 60_000);
    return () => { alive = false; es.close(); clearInterval(poll); };
  }, []);
  return counts;
}

function isActive(pathname: string, item: NavItem) {
  if (item.href === "/") return pathname === "/";
  if (item.href.startsWith("/#")) return false;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

export function Sidebar() {
  const pathname = usePathname();
  const owner = useOwnerActionCount();
  const { totals } = useCompanyNow();
  return (
    <aside className="hidden lg:flex w-[232px] shrink-0 flex-col gap-3 sticky top-0 h-screen py-4 pl-4">
      {/* Brand */}
      <div className="flex items-center gap-3 px-2 pt-1 pb-2">
        <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[#7d8bff] via-[#5a6bff] to-[#2fd4e6] shadow-[0_8px_24px_-8px_rgba(109,124,255,0.9)]">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 19V5l14 14V5" />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">Nexora OS</div>
          <div className="text-[10.5px] text-ink-3">Your AI company, for what’s next.</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="glass rounded-2xl p-2 flex-1 min-h-0 overflow-y-auto">
        <ul className="space-y-0.5">
          {nav.map((item) => {
            const { label, icon: Icon, live, href } = item;
            const isOwner = href === "/action-center";
            const count = isOwner ? (owner.total || undefined) : item.count;
            const attention = isOwner ? owner.blocking > 0 : item.attention;
            const active = isActive(pathname, item);
            return (
              <li key={label}>
                <Link
                  href={href}
                  className={cn(
                    "group relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[13px] transition-colors",
                    active ? "bg-white/[0.08] text-ink" : "text-ink-2 hover:bg-white/[0.05] hover:text-ink"
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                  )}
                  <Icon className={cn("h-4 w-4", active ? "text-brand" : "text-ink-3 group-hover:text-ink-2")} strokeWidth={1.8} />
                  <span className="flex-1 text-left">{label}</span>
                  {live && (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-conference">
                      <span className="relative h-1.5 w-1.5 rounded-full bg-conference pulse-ring" /> LIVE
                    </span>
                  )}
                  {count !== undefined && (
                    <span
                      className={cn(
                        "rounded-md px-1.5 py-px text-[10.5px] font-medium num",
                        attention ? "bg-ceo/15 text-ceo" : "bg-white/[0.06] text-ink-3"
                      )}
                    >
                      {count}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* What the company is doing — the same counts the office floor shows */}
      <div className="glass rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Right now</h3>
          <Link href="/work" className="text-[10.5px] text-ink-3 hover:text-brand">Work →</Link>
        </div>
        {!totals ? (
          <p className="mt-3 text-[11.5px] text-ink-3">Reading the floor…</p>
        ) : (
          <>
            <ul className="mt-3 space-y-1.5">
              {([
                ["Working", totals.working, "#4f8bff"],
                ["Waiting", totals.waiting, "#f5b942"],
                ["Stuck", totals.blocked, "#ff5c7a"],
                ["Available", totals.idle, "#7c8699"],
              ] as const).map(([label, value, color]) => (
                <li key={label} className="text-[11px]">
                  <div className="flex justify-between text-ink-2">
                    <span>{label}</span>
                    <span className="num text-ink">{value}</span>
                  </div>
                  <div className="mt-0.5 h-1 rounded-full bg-white/[0.06]">
                    <div className="h-1 rounded-full" style={{ width: `${totals.agents ? (value / totals.agents) * 100 : 0}%`, background: color }} />
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[11px]">
              <span className="text-ink-2">{totals.agents} {totals.agents === 1 ? "agent" : "agents"}</span>
              <Link href="/work" className="num text-ink-3 hover:text-brand">{totals.openTasks} open tasks</Link>
            </div>
          </>
        )}
      </div>

      {/* Promo tile */}
      <div className="relative overflow-hidden rounded-2xl border border-line p-4 bg-gradient-to-br from-[#161d3a] via-[#0f152b] to-[#0a0f1f]">
        <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full bg-brand/30 blur-2xl" />
        <div className="absolute -left-8 bottom-0 h-20 w-20 rounded-full bg-support/20 blur-2xl" />
        <Sparkles className="h-4 w-4 text-ceo" />
        <p className="mt-2 text-[12.5px] leading-snug text-ink">A more capable company. A brighter tomorrow.</p>
        <Link href="/agents/hire" className="mt-3 inline-block text-[11px] font-medium text-brand hover:text-ink">Hire your next agent →</Link>
      </div>
    </aside>
  );
}

