"use client";

import Link from "next/link";
import { ClipboardList, MessageSquare, Users, X } from "lucide-react";
import { AgentAvatar } from "@/components/ui/Avatar";
import { departments } from "@/lib/mock-data";
import type { FloorAgent } from "@/lib/office/floor";
import { STATE_META, StateDot } from "./states";

/**
 * One real agent, opened from the floor. Everything here is a real id: the
 * chat is the agent's own chat, the task is the same task Work shows, and
 * the wait links to the page that can resolve it. Nothing about this panel
 * is office-only.
 */
export function AgentCard({ agent, onClose }: { agent: FloorAgent; onClose: () => void }) {
  const meta = STATE_META[agent.state];
  const dept = departments[agent.dept];
  return (
    <div className="glass-strong w-full max-w-[340px] overflow-hidden rounded-2xl shadow-2xl shadow-black/60">
      <header className="flex items-start gap-2.5 border-b border-line px-3 py-2.5">
        <AgentAvatar id={agent.id} dept={agent.dept} name={agent.name} size={34} />
        <div className="min-w-0 flex-1">
          <h3 dir="auto" className="truncate text-[13.5px] font-semibold tracking-tight text-ink">{agent.name}</h3>
          <p dir="auto" className="truncate text-[11px] text-ink-3">{agent.role}</p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 text-ink-3 hover:text-ink" aria-label="Close"><X className="h-4 w-4" /></button>
      </header>

      <div className="space-y-2.5 px-3 py-3">
        <div className="flex items-start gap-2">
          <StateDot state={agent.state} size={18} spin />
          <div className="min-w-0">
            <div className="text-[12px] font-medium" style={{ color: meta.color }}>{meta.label}</div>
            <div dir="auto" className="text-[11.5px] leading-relaxed text-ink-2">{agent.label}</div>
          </div>
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
          <dt className="text-ink-3">Department</dt>
          <dd className="truncate text-ink-2">{dept?.name ?? agent.dept}</dd>
          <dt className="text-ink-3">Reports to</dt>
          <dd className="truncate text-ink-2">
            {agent.managerId ? <Link href={`/agents/${agent.managerId}`} className="hover:text-brand">{agent.managerName}</Link> : "The owner"}
          </dd>
          {agent.reports > 0 && (
            <>
              <dt className="text-ink-3">Team</dt>
              <dd className="text-ink-2">{agent.reports} {agent.reports === 1 ? "person" : "people"}</dd>
            </>
          )}
        </dl>

        {agent.currentTask && (
          <Link
            href={`/work?task=${agent.currentTask.id}`}
            className="block rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 transition-colors hover:border-brand/40"
          >
            <span className="block text-[10px] uppercase tracking-[0.12em] text-ink-3">Current task</span>
            <span dir="auto" className="block truncate text-[12px] text-ink-2">{agent.currentTask.title}</span>
          </Link>
        )}
        {agent.otherOpen > 0 && (
          <Link href={`/work`} className="block text-[11px] text-ink-3 hover:text-brand">
            + {agent.otherOpen} more open {agent.otherOpen === 1 ? "task" : "tasks"}
          </Link>
        )}
        {agent.href && (
          <Link href={agent.href} className="block text-[11.5px] text-brand hover:text-ink">Resolve what it is waiting for →</Link>
        )}
      </div>

      <footer className="flex items-center gap-1.5 border-t border-line px-3 py-2.5">
        <Link href={`/agents/${agent.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-brand/45 bg-brand/[0.14] px-2.5 py-1.5 text-[11.5px] font-medium text-ink transition-colors hover:bg-brand/[0.2]">
          <MessageSquare className="h-3.5 w-3.5" /> Chat
        </Link>
        {agent.reports > 0 && (
          <Link href={`/work?manager=${agent.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink">
            <Users className="h-3.5 w-3.5" /> Team
          </Link>
        )}
        <Link href={`/work?agent=${agent.id}`} className="ms-auto inline-flex items-center gap-1.5 text-[11.5px] text-ink-3 transition-colors hover:text-ink">
          <ClipboardList className="h-3.5 w-3.5" /> Work
        </Link>
      </footer>
    </div>
  );
}
