"use client";

import { motion } from "framer-motion";
import { FolderKanban, CheckSquare, Heart, BarChart3, TrendingUp } from "lucide-react";
import { kpis } from "@/lib/mock-data";
import { Sparkline } from "@/components/ui/Sparkline";
import { rgba } from "@/lib/iso";
import { SampleBadge } from "./SampleBadge";

const ICONS = { projects: FolderKanban, tasks: CheckSquare, csat: Heart, revenue: BarChart3 } as const;

export function KpiStrip() {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Business metrics</h2>
        <SampleBadge />
      </div>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {kpis.map((k, i) => {
        const Icon = ICONS[k.id as keyof typeof ICONS];
        return (
          <motion.div
            key={k.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.07, duration: 0.4 }}
            className="glass relative overflow-hidden rounded-2xl p-4"
          >
            <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl" style={{ background: rgba(k.color, 0.18) }} />
            <div className="flex items-start justify-between">
              <span className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: rgba(k.color, 0.14), color: k.color }}>
                <Icon className="h-4 w-4" strokeWidth={2} />
              </span>
              <Sparkline data={k.spark} color={k.color} width={84} height={30} />
            </div>
            <p className="mt-3 text-[11px] text-ink-3">{k.label}</p>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="text-[24px] font-semibold tracking-tight num">{k.value}</span>
              <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-operations">
                <TrendingUp className="h-3 w-3" /> {k.delta}
              </span>
            </div>
          </motion.div>
        );
      })}
    </div>
    </div>
  );
}
