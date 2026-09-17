"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Crown, Settings2, Code2, BarChart3, Users, Headphones, Landmark, ChevronRight } from "lucide-react";
import { deptList, departments, DeptId, agentById, agents } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { rgba } from "@/lib/iso";
import { AgentAvatar, AvatarStack } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const ICON: Record<DeptId, typeof Crown> = {
  ceo: Crown, operations: Settings2, engineering: Code2, sales: BarChart3, support: Headphones, finance: Landmark, conference: Users,
};

export function DepartmentStrip({ selected, onSelect }: { selected: DeptId | null; onSelect: (d: DeptId | null) => void }) {
  const sel = selected ? departments[selected] : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 xl:grid-cols-7">
        {deptList.map((d) => {
          const Icon = ICON[d.id];
          const active = selected === d.id;
          return (
            <button
              key={d.id}
              onClick={() => onSelect(active ? null : d.id)}
              className={cn(
                "glass group flex flex-col items-start gap-1.5 rounded-xl px-3 py-2.5 text-left transition-all hover:-translate-y-0.5",
                active && "ring-1"
              )}
              style={active ? { boxShadow: `0 0 0 1px ${rgba(d.color, 0.6)}, 0 12px 30px -12px ${rgba(d.color, 0.5)}`, background: rgba(d.color, 0.08) } : undefined}
            >
              <div className="flex w-full items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md" style={{ background: rgba(d.color, 0.16), color: d.color }}>
                  <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
                </span>
                <span className="truncate text-[12px] font-semibold">{d.shortName}</span>
                <span className="ml-auto text-[10.5px] text-ink-3 num">{d.headcount}</span>
              </div>
              <div className="flex w-full items-center justify-between text-[10.5px]">
                <span className="text-ink-3 capitalize">{d.status}</span>
                <span className="num font-medium" style={{ color: d.color }}>{d.metric.value}</span>
              </div>
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {sel && (
          <motion.div
            key={sel.id}
            initial={{ opacity: 0, y: -6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -6, height: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="glass flex flex-col gap-4 rounded-2xl p-4 md:flex-row md:items-center" style={{ borderColor: rgba(sel.color, 0.35) }}>
              <div className="flex items-center gap-3 md:w-64">
                <span className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: rgba(sel.color, 0.16), color: sel.color }}>
                  {(() => { const I = ICON[sel.id]; return <I className="h-5 w-5" strokeWidth={2} />; })()}
                </span>
                <div>
                  <div className="text-[14px] font-semibold">{sel.name}</div>
                  <div className="text-[11px] italic text-ink-3">“{sel.tagline}”</div>
                </div>
              </div>
              <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Lead" value={<span className="flex items-center gap-1.5"><AgentAvatar id={sel.lead} size={18} /> {agentById[sel.lead].name}</span>} />
                <Stat label="Agents" value={<AvatarStack ids={agents.filter((a) => a.dept === sel.id || (sel.id === "conference" && ["atlas", "vera", "kai"].includes(a.id))).map((a) => a.id)} size={18} max={4} />} />
                <Stat label="Active tasks" value={<span className="num">{sel.activeTasks}</span>} />
                <Stat label={sel.metric.label} value={<span className="num" style={{ color: sel.color }}>{sel.metric.value} <span className="text-[10px] text-ink-3">{sel.metric.delta}</span></span>} />
              </div>
              <div className="flex items-center gap-2 md:flex-col md:items-end">
                <Badge color={sel.color} dot className="capitalize">{sel.status}</Badge>
                <span className="text-[11px] text-ink-3">{sel.focus}</span>
                <Button variant="outline" size="xs">Open department <ChevronRight className="h-3 w-3" /></Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className="mt-1 text-[12.5px] font-medium">{value}</div>
    </div>
  );
}
