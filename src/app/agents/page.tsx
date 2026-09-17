"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Bot, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { AgentAvatar } from "@/components/ui/Avatar";
import { RuntimeBadge } from "@/components/agents/RuntimeBadge";
import { api, errorText } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";
import { departments, deptList } from "@/lib/mock-data";

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agents().then((r) => setAgents(r.agents)).catch((e) => setError(errorText(e)));
  }, []);

  const groups = deptList
    .filter((d) => d.id !== "conference")
    .map((d) => ({ dept: d, agents: (agents ?? []).filter((a) => a.dept === d.id) }))
    .filter((g) => g.agents.length > 0);

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Agents</h1>
          <p className="text-[12.5px] text-ink-3">
            Every agent runs on its own runtime, provider and model. {agents ? `${agents.length} hired.` : ""}
          </p>
        </div>
        <Link href="/agents/hire">
          <Button variant="primary" size="md">
            <Plus className="h-4 w-4" /> Hire agent
          </Button>
        </Link>
      </div>

      {error && <div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!agents && !error && (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading agents…
        </div>
      )}

      <div className="space-y-5">
        {groups.map(({ dept, agents }) => (
          <section key={dept.id}>
            <div className="mb-2 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: dept.color }} />
              <h2 className="text-[13px] font-semibold">{dept.name}</h2>
              <span className="text-[11px] text-ink-3 num">{agents.length}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {agents.map((a) => (
                <Link key={a.id} href={`/agents/${a.id}`} className="glass group flex flex-col gap-3 rounded-2xl p-4 transition-colors hover:bg-white/[0.05]">
                  <div className="flex items-center gap-3">
                    <AgentAvatar id={a.id} dept={a.dept} name={a.name} online={a.status} size={40} status />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold text-ink">{a.name}</div>
                      <div className="truncate text-[11.5px] text-ink-3">{a.role}</div>
                    </div>
                    <Badge color={departments[a.dept].color}>{departments[a.dept].shortName}</Badge>
                  </div>
                  <RuntimeBadge agent={a} className="self-start" />
                  <div className="flex flex-wrap gap-1">
                    {a.skills.slice(0, 3).map((s) => (
                      <span key={s} className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10.5px] text-ink-2">
                        {s}
                      </span>
                    ))}
                    {a.skills.length > 3 && <span className="text-[10.5px] text-ink-3">+{a.skills.length - 3}</span>}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
        {agents && agents.length === 0 && (
          <div className="glass grid place-items-center rounded-2xl p-10 text-center">
            <Bot className="h-8 w-8 text-ink-3" />
            <p className="mt-2 text-[13px] text-ink-2">No agents yet. Hire your first one.</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
