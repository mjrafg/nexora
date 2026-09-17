"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, X } from "lucide-react";
import { api, errorText, type TaskStatus, type TaskView } from "@/lib/client-api";
import { PriorityTag, STATUS_META, StatusDot, when } from "./bits";
import { cn } from "@/lib/utils";

const ORDER: TaskStatus[] = ["IN_PROGRESS", "BLOCKED", "TODO", "DONE"];

/** One agent's own work, beside their conversation. */
export function MyWorkPanel({ agentId, agentName, onClose }: { agentId: string; agentName: string; onClose: () => void }) {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    return api.tasks({ agent: agentId, status: "all" })
      .then((d) => { setTasks(d.tasks); setError(null); })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, [agentId]);

  useEffect(() => {
    let alive = true;
    api.tasks({ agent: agentId, status: "all" })
      .then((d) => { if (alive) { setTasks(d.tasks); setError(null); } })
      .catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [agentId]);
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const groups = ORDER.map((s) => [s, (tasks ?? []).filter((t) => t.status === s)] as const).filter(([, rows]) => rows.length);

  return (
    <section className="glass flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
          {agentName}&apos;s work {tasks && <span className="num font-normal normal-case tracking-normal">· {tasks.filter((t) => t.status !== "DONE" && t.status !== "CANCELLED").length} open</span>}
        </h2>
        <button type="button" onClick={() => void load()} title="Reload" className="text-ink-3 hover:text-ink">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
        <Link href="/work" className="text-[11px] text-brand hover:text-ink">All work</Link>
        <button type="button" onClick={onClose} title="Close" className="text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {tasks === null && !error && <div className="flex items-center gap-2 p-3 text-[11.5px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>}
        {error && <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] text-[#ff8ea3]">{error}</p>}
        {tasks && !tasks.length && (
          <p className="p-3 text-[11.5px] leading-relaxed text-ink-3">
            No work assigned. Tasks given to {agentName} appear here, and they start on them without being told.
          </p>
        )}
        {groups.map(([status, rows]) => (
          <div key={status}>
            <h3 className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">{STATUS_META[status].label}</h3>
            <ul className="space-y-1">
              {rows.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/work?task=${t.id}`}
                    className={cn(
                      "flex items-start gap-2 rounded-lg border px-2 py-1.5 transition-colors",
                      t.status === "BLOCKED" ? "border-warning/30 bg-warning/[0.06]" : "border-line bg-white/[0.02] hover:bg-white/[0.05]"
                    )}
                  >
                    <StatusDot status={t.status} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span dir="auto" className="truncate text-[12px] text-ink">{t.title}</span>
                        <PriorityTag priority={t.priority} />
                      </span>
                      <span className="block truncate text-[10.5px] text-ink-3">
                        {t.status === "BLOCKED" && t.blockedReason ? t.blockedReason : t.status === "DONE" && t.resultSummary ? t.resultSummary : when(t.updatedAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
