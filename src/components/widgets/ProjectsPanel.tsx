import { FolderKanban } from "lucide-react";
import { projects, departments, agentById } from "@/lib/mock-data";
import { Panel } from "@/components/ui/Panel";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { SampleBadge } from "./SampleBadge";

const HEALTH = { "on track": "#3dd68c", "at risk": "#f5b942", blocked: "#ff5c7a" } as const;

export function ProjectsPanel() {
  return (
    <Panel title="Projects in Progress" subtitle="Placeholder — the real ones live on the Projects page" icon={<FolderKanban className="h-4 w-4 text-engineering" strokeWidth={1.8} />} action={<SampleBadge />}>
      <ul className="space-y-2.5">
        {projects.map((p) => {
          const d = departments[p.dept];
          return (
            <li key={p.id}>
              <div className="flex items-center gap-2">
                <AgentAvatar id={p.owner} size={20} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{p.name}</span>
                <Badge color={HEALTH[p.health]} dot>{p.health}</Badge>
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-3">
                <div className="h-1.5 flex-1 rounded-full bg-white/[0.06]">
                  <div className="h-1.5 rounded-full" style={{ width: `${p.progress}%`, background: `linear-gradient(90deg, ${d.color}, ${d.color}aa)` }} />
                </div>
                <span className="num w-8 text-right text-ink-2">{p.progress}%</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-3">
                <span style={{ color: d.color }}>{d.shortName}</span>
                <span>· {agentById[p.owner].name}</span>
                <span className="num">· {p.tasks.done}/{p.tasks.total} tasks</span>
                <span className="ml-auto">Due {p.due}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
