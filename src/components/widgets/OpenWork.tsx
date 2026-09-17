"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PriorityTag, STATUS_META, StatusDot } from "@/components/work/bits";
import { api, type TaskView } from "@/lib/client-api";

/**
 * What the company actually has open, newest urgency first. The same rows
 * the Work page shows — no second source, nothing invented.
 */
export function OpenWork({ limit = 7 }: { limit?: number }) {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => { api.tasks({ status: "open" }).then((d) => alive && setTasks(d.tasks)).catch(() => undefined); };
    const first = setTimeout(load, 0);
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearTimeout(first); clearInterval(t); };
  }, []);

  return (
    <section className="glass rounded-2xl p-4">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold tracking-tight">Open work</h3>
        <Link href="/work" className="text-[10.5px] text-ink-3 hover:text-brand">All work →</Link>
      </div>
      {!tasks && <div className="flex items-center gap-2 text-[11.5px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>}
      {tasks && !tasks.length && <p className="text-[11.5px] text-ink-3">Nothing is open. Give someone an outcome and it appears here.</p>}
      {tasks && tasks.length > 0 && (
        <ul className="space-y-1.5">
          {tasks.slice(0, limit).map((t) => (
            <li key={t.id}>
              <Link href={`/work?task=${t.id}`} className="flex items-start gap-2.5 rounded-lg px-1 py-1 transition-colors hover:bg-white/[0.04]">
                <StatusDot status={t.status} size={18} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span dir="auto" className="truncate text-[12px] text-ink">{t.title}</span>
                    <PriorityTag priority={t.priority} />
                  </span>
                  <span dir="auto" className="block truncate text-[10.5px] text-ink-3">
                    {t.assignedTo ? t.assignedTo.name : "unassigned"} · {STATUS_META[t.status].label}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {tasks.length > limit && (
            <li><Link href="/work" className="block px-1 pt-1 text-[11px] text-ink-3 hover:text-brand">+ {tasks.length - limit} more</Link></li>
          )}
        </ul>
      )}
    </section>
  );
}
