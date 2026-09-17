import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { agents, departments, companyStatus } from "@/lib/mock-data";
import { Panel } from "@/components/ui/Panel";
import { AgentAvatar } from "@/components/ui/Avatar";

export function AgentsPanel() {
  const specialties = new Set(agents.map((a) => a.role)).size;
  return (
    <Panel title="Our AI Agents" subtitle="Different skills. One team." icon={<Bot className="h-4 w-4 text-brand" strokeWidth={1.8} />} action={<Link href="/agents" className="text-[11px] font-medium text-brand hover:text-ink transition-colors inline-flex items-center gap-1">Manage <span aria-hidden>→</span></Link>}>
      <div className="flex flex-wrap gap-1.5">
        {agents.slice(0, 11).map((a) => (
          <span key={a.id} className="group relative">
            <AgentAvatar id={a.id} size={32} status />
            <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-bg-2 px-2 py-1 text-[10.5px] opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
              <span className="font-medium text-ink">{a.name}</span> <span className="text-ink-3">· {a.role}</span>
            </span>
          </span>
        ))}
        <Link href="/agents/hire" title="Hire an agent" className="grid h-8 w-8 place-items-center rounded-full border border-dashed border-line-2 text-ink-3 hover:border-brand hover:text-brand">
          <Plus className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
        <div>
          <div className="text-[16px] font-semibold num">{companyStatus.agentsOnline}</div>
          <div className="text-[10.5px] text-ink-3">Active now</div>
        </div>
        <div>
          <div className="text-[16px] font-semibold num">{specialties}</div>
          <div className="text-[10.5px] text-ink-3">Specialties</div>
        </div>
        <div>
          <div className="text-[16px] font-semibold text-gradient">∞</div>
          <div className="text-[10.5px] text-ink-3">Possibilities</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {Object.values(departments).filter((d) => d.id !== "conference").map((d) => (
          <span key={d.id} className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10.5px] text-ink-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.color }} /> {d.shortName} <span className="text-ink-3 num">{d.headcount}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}
