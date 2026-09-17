"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Loader2, Users } from "lucide-react";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Field, Select } from "@/components/ui/Form";
import { api, errorText, type TeamMember } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/**
 * Where this agent sits in the company: who they report to, and who reports
 * to them. An agent with reports is a manager — there is no separate thing
 * to create, and the management tools appear for them automatically.
 */
export function OrgSection({ agent, onSaved }: { agent: AgentView; onSaved: (a: AgentView) => void }) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [managerId, setManagerId] = useState(agent.managerAgentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);

  useEffect(() => { api.agents().then((r) => setAgents(r.agents)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!agent.reports.length) return;
    api.tasks({ manager: agent.id }).then((d) => setTeam(d.workload)).catch(() => undefined);
  }, [agent.id, agent.reports.length]);

  const dirty = (agent.managerAgentId ?? "") !== managerId;
  // nobody may report to their own report, and nobody reports to themselves
  const descendants = new Set<string>();
  const walk = (id: string) => {
    for (const a of agents) if (a.managerAgentId === id && !descendants.has(a.id)) { descendants.add(a.id); walk(a.id); }
  };
  walk(agent.id);
  const candidates = agents.filter((a) => a.id !== agent.id && !descendants.has(a.id));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateAgent(agent.id, { managerAgentId: managerId || null });
      onSaved(r.agent);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const byId = new Map(team.map((m) => [m.agentId, m]));

  return (
    <section className="glass rounded-2xl p-4">
      <header className="mb-3 flex items-center gap-2">
        <Users className="h-4 w-4 text-brand" />
        <div>
          <h2 className="text-[13px] font-semibold tracking-tight">Place in the company</h2>
          <p className="text-[11px] text-ink-3">Who {agent.name} answers to, and who answers to {agent.name}.</p>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_auto] sm:items-end">
        <Field label="Reports to">
          <Select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={busy}>
            <option value="">Nobody — reports to you</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>{a.name} · {a.role}</option>
            ))}
          </Select>
        </Field>
        {dirty && (
          <Button variant="primary" size="sm" className="mb-0.5" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-[11.5px] text-[#ff8ea3]">{error}</p>}

      <div className="mt-4 border-t border-line pt-3">
        <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">
          Team{agent.reports.length ? ` · ${agent.reports.length}` : ""}
        </h3>
        {agent.reports.length === 0 ? (
          <p className="text-[11.5px] leading-relaxed text-ink-3">
            Nobody reports to {agent.name} yet. Set this agent as someone&apos;s manager on their own page, and {agent.name} gains the
            management tools — seeing the team, creating work and assigning it.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {agent.reports.map((r) => {
              const m = byId.get(r.id);
              return (
                <li key={r.id}>
                  <Link
                    href={`/agents/${r.id}`}
                    className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.02] px-3 py-2 transition-colors hover:border-brand/40 hover:bg-white/[0.05]"
                  >
                    <AgentAvatar id={r.id} dept={r.dept} name={r.name} size={30} />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{r.name}</span>
                      <span className="block truncate text-[10.5px] text-ink-3">{r.role}</span>
                      {m && (
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-3">
                          <span className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            m.status === "WORKING" ? "bg-brand" : m.status === "BLOCKED" ? "bg-warning" : m.status === "WAITING" ? "bg-[#f5b942]" : "bg-ink-3"
                          )} />
                          {m.currentTask
                            ? <span className="truncate">{m.currentTask}</span>
                            : m.status === "IDLE" ? "Idle" : m.status === "BLOCKED" ? "Blocked" : m.status === "WAITING" ? "Waiting" : "Working"}
                          {m.pendingTasks > 0 && <span className="num">· {m.pendingTasks} queued</span>}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
