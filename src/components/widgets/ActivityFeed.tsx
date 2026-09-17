import { Activity } from "lucide-react";
import { activity, agentById, departments } from "@/lib/mock-data";
import { Panel, PanelLink } from "@/components/ui/Panel";
import { AgentAvatar } from "@/components/ui/Avatar";

export function ActivityFeed() {
  return (
    <Panel title="Live Activity" subtitle="Across all departments" icon={<Activity className="h-4 w-4 text-support" strokeWidth={1.8} />} action={<PanelLink>View all</PanelLink>}>
      <ol className="relative space-y-3 pl-4 before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-px before:bg-line">
        {activity.map((a) => {
          const agent = agentById[a.agent];
          const dept = departments[a.dept];
          return (
            <li key={a.id} className="relative">
              <span className="absolute -left-4 top-1.5 h-[11px] w-[11px] rounded-full border-2 border-bg-2" style={{ background: dept.color }} />
              <div className="flex items-start gap-2">
                <AgentAvatar id={a.agent} size={20} />
                <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink-2">
                  <span className="font-medium text-ink">{agent.name}</span> {a.text}
                  <span className="ml-1 text-[10.5px] text-ink-3 num">{a.ago}</span>
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
