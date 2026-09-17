import { Terminal, Cpu, Globe } from "lucide-react";
import type { AgentView, RuntimeType } from "@/lib/runtime/types";
import { PROVIDERS, RUNTIMES, modelLabel } from "@/lib/runtime/catalog";
import { cn } from "@/lib/utils";

export const RUNTIME_COLORS: Record<RuntimeType, string> = {
  "claude-code": "#d9a45b",
  codex: "#7de8b3",
  api: "#7fb4ff",
};

export function RuntimeIcon({ type, className }: { type: RuntimeType; className?: string }) {
  const Icon = type === "claude-code" ? Terminal : type === "codex" ? Cpu : Globe;
  return <Icon className={className} strokeWidth={1.8} />;
}

/** Compact "Claude Code · Anthropic · Claude Haiku 4.5" pill. */
export function RuntimeBadge({ agent, className }: { agent: AgentView; className?: string }) {
  const rt = agent.runtime.runtimeType;
  const color = RUNTIME_COLORS[rt];
  return (
    <span
      className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10.5px] whitespace-nowrap", className)}
      style={{ borderColor: `${color}40`, background: `${color}14`, color }}
      title={`${RUNTIMES[rt].label} · ${PROVIDERS[agent.connection.providerType].label} · ${agent.runtime.model}`}
    >
      <RuntimeIcon type={rt} className="h-3 w-3" />
      <span className="font-medium">{RUNTIMES[rt].label}</span>
      <span className="opacity-60">·</span>
      <span className="truncate opacity-90">{modelLabel(agent.connection.providerType, rt, agent.runtime.model)}</span>
    </span>
  );
}
