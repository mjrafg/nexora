import { Trophy } from "lucide-react";
import { agents, departments } from "@/lib/mock-data";
import { Panel, PanelLink } from "@/components/ui/Panel";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Sparkline } from "@/components/ui/Sparkline";

export function AgentPerformance() {
  const top = [...agents].sort((a, b) => b.tasksDone - a.tasksDone).slice(0, 6);
  return (
    <Panel title="Agent Performance" subtitle="Top performers · 7 days" icon={<Trophy className="h-4 w-4 text-ceo" strokeWidth={1.8} />} action={<PanelLink>Leaderboard</PanelLink>} bodyClassName="px-2 pb-2">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-ink-3">
            <th className="px-2 pb-1.5 text-left font-medium">Agent</th>
            <th className="px-2 pb-1.5 text-right font-medium">Tasks</th>
            <th className="px-2 pb-1.5 text-right font-medium">On-time</th>
            <th className="px-2 pb-1.5 text-right font-medium">Quality</th>
            <th className="px-2 pb-1.5 text-right font-medium">Trend</th>
          </tr>
        </thead>
        <tbody>
          {top.map((a) => {
            const d = departments[a.dept];
            return (
              <tr key={a.id} className="rounded-lg hover:bg-white/[0.03]">
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <AgentAvatar id={a.id} size={22} />
                    <div className="leading-tight">
                      <div className="font-medium text-ink">{a.name}</div>
                      <div className="text-[10px]" style={{ color: d.color }}>{a.role}</div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right num text-ink">{a.tasksDone}</td>
                <td className="px-2 py-1.5 text-right num text-ink-2">{a.onTime}%</td>
                <td className="px-2 py-1.5 text-right num text-ink-2">{a.quality.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-right"><Sparkline data={a.trend} color={d.color} width={56} height={18} fill={false} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
