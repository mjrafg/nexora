"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Server, Loader2, Check, Wrench } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { api, errorText } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";
import type { McpGrant, McpServerView } from "@/lib/mcp/types";
import { cn } from "@/lib/utils";

/** Runtime-independent: MCP access is granted to the agent, not to its AI engine. */
export function AgentMcpAccess({ agent, onChanged }: { agent: AgentView; onChanged?: (a: AgentView) => void }) {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [grants, setGrants] = useState<McpGrant[]>(agent.mcpGrants ?? []);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.mcpServers().then((r) => setServers(r.servers)).catch((e) => setError(errorText(e)));
  }, []);

  function grantFor(serverId: string): McpGrant | undefined {
    return grants.find((g) => g.serverId === serverId);
  }
  function setGrant(serverId: string, next: McpGrant | null) {
    setGrants((cur) => {
      const rest = cur.filter((g) => g.serverId !== serverId);
      return next ? [...rest, next] : rest;
    });
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.setAgentGrants(agent.id, grants);
      setGrants(r.agent.mcpGrants);
      setDirty(false);
      onChanged?.(r.agent);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="MCP Access"
      subtitle="Company tools this agent may use. Kept when you change the runtime."
      icon={<Server className="h-4 w-4 text-brand" />}
      action={dirty ? (
        <Button variant="primary" size="xs" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Save
        </Button>
      ) : undefined}
    >
      {!servers ? (
        <div className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading servers…</div>
      ) : servers.length === 0 ? (
        <p className="text-[12px] text-ink-3">
          No MCP servers configured yet. <Link href="/settings/mcp" className="text-brand">Add one in Settings → Tools &amp; MCP</Link>.
        </p>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => {
            const grant = grantFor(s.id);
            const enabled = !!grant?.enabled;
            const liveTools = s.tools.filter((t) => !t.missing);
            const mode: "all" | "selected" = grant && grant.tools !== "all" ? "selected" : "all";
            const selected = grant && grant.tools !== "all" ? grant.tools : [];
            return (
              <div key={s.id} className="rounded-lg border border-line bg-white/[0.02] p-2.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setGrant(s.id, enabled ? null : { serverId: s.id, enabled: true, tools: "all" })}
                    className={cn("relative h-4 w-7 rounded-full transition-colors", enabled ? "bg-brand" : "bg-white/15")}
                    aria-label={enabled ? "Disable" : "Enable"}
                  >
                    <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all", enabled ? "left-3.5" : "left-0.5")} />
                  </button>
                  <span className="text-[13px] font-medium text-ink">{s.name}</span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-ink-3"><Wrench className="h-3 w-3" /> {liveTools.length}</span>
                  {!s.enabled && <span className="rounded bg-warning/15 px-1.5 text-[10px] text-warning">server disabled</span>}
                </div>

                {enabled && liveTools.length > 0 && (
                  <div className="mt-2 pl-9">
                    <div className="mb-1 flex gap-3 text-[11.5px]">
                      <label className="flex cursor-pointer items-center gap-1 text-ink-2">
                        <input type="radio" checked={mode === "all"} onChange={() => setGrant(s.id, { serverId: s.id, enabled: true, tools: "all" })} className="accent-[#6d7cff]" /> All tools
                      </label>
                      <label className="flex cursor-pointer items-center gap-1 text-ink-2">
                        <input type="radio" checked={mode === "selected"} onChange={() => setGrant(s.id, { serverId: s.id, enabled: true, tools: liveTools.map((t) => t.fullName) })} className="accent-[#6d7cff]" /> Selected tools
                      </label>
                    </div>
                    {mode === "selected" && (
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {liveTools.map((t) => {
                          const on = selected.includes(t.fullName);
                          return (
                            <label key={t.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11.5px] text-ink-2 hover:bg-white/[0.04]" title={t.description}>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) => {
                                  const next = e.target.checked ? [...selected, t.fullName] : selected.filter((x) => x !== t.fullName);
                                  setGrant(s.id, { serverId: s.id, enabled: true, tools: next });
                                }}
                                className="accent-[#6d7cff]"
                              />
                              <span className="truncate font-mono text-[10.5px]">{t.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && <div className="mt-2 text-[11px] text-[#ff8ea3]">{error}</div>}
    </Panel>
  );
}
