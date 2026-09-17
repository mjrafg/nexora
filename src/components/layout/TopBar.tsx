"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Bell, LogOut, Plus, Command } from "lucide-react";
import { useCompanyNow } from "@/lib/use-company-now";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

export function TopBar() {
  const router = useRouter();
  const { totals, actions } = useCompanyNow();
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { user?: { username: string } } | null) => setUsername(d?.user?.username ?? null))
      .catch(() => setUsername(null));
  }, []);
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }
  const initials = (username ?? "?").slice(0, 2).toUpperCase();
  return (
    <header className="sticky top-0 z-30 -mx-4 px-4 pt-4 pb-3 backdrop-blur-xl bg-bg/60">
      <div className="flex items-center gap-3">
        {/* Search */}
        <label className="group flex h-10 min-w-0 flex-1 max-w-xl items-center gap-2 rounded-xl border border-line bg-white/[0.04] px-3 focus-within:border-brand/50 focus-within:bg-white/[0.06] transition-colors">
          <Search className="h-4 w-4 text-ink-3 group-focus-within:text-brand" strokeWidth={2} />
          <input
            placeholder="Search people, projects, or anything…"
            className="w-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
          />
          <kbd className="hidden sm:flex items-center gap-0.5 rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-ink-3">
            <Command className="h-2.5 w-2.5" /> K
          </kbd>
        </label>

        {/* What the company is actually doing, counted from real work */}
        <div className="hidden xl:flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 h-10">
          <span className={cn("h-2 w-2 rounded-full", totals?.working ? "bg-operations" : "bg-ink-3")} />
          <span className="text-[12px] text-ink num">{totals ? totals.agents : "—"} agents</span>
          <span className="text-[11px] text-ink-3 num">
            · {totals?.working ?? 0} working · {totals?.waiting ?? 0} waiting · {totals?.openTasks ?? 0} open tasks
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="hidden sm:block">
            <Button variant="primary" size="sm">
              <Plus className="h-3.5 w-3.5" /> New task
            </Button>
          </span>
          <button className="relative grid h-10 w-10 place-items-center rounded-xl border border-line bg-white/[0.03] text-ink-2 hover:text-ink hover:bg-white/[0.06]">
            <Bell className="h-4 w-4" strokeWidth={1.8} />
            <span className="absolute right-2.5 top-2.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-danger px-1 text-[9px] font-semibold text-white">
              {actions}
            </span>
          </button>
          <button
            onClick={logout}
            title="Sign out"
            className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] pl-1.5 pr-1.5 hover:bg-white/[0.06] sm:pr-2.5"
          >
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-[#f5b942] to-[#ff8a3d] text-[11px] font-semibold text-[#1a1206]">
              {initials}
            </span>
            <span className="hidden sm:block text-left leading-tight">
              <span className="block text-[12px] font-medium">{username ?? "…"}</span>
              <span className="block text-[10.5px] text-ink-3">Owner</span>
            </span>
            <LogOut className="hidden h-3.5 w-3.5 text-ink-3 sm:block" />
          </button>
        </div>
      </div>
    </header>
  );
}
