/* ------------------------------------------------------------------
   Nexora Tool Runner — the ONE execution path for every tool an agent
   calls, whatever the runtime:

     Agent (Claude Code / Codex / API)
       ↓  mcp__<slug>__<tool>   (CLI: stdio proxy + turn token; API: in-process)
     runTool()
       ↓  classify → Side-Effect Guard (ledger, dedup, uncertain handling)
     internal tool server  |  MCP engine → MCP server

   It also records the tool's activity event (start → done/failed with the
   guard verdict), so adapters stay silent for these tools and the timeline
   shows "duplicate prevented" consistently.
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import type { AgentRecord } from "@/lib/runtime/types";
import type { AllowedTool, ToolCallRecord } from "@/lib/mcp/types";
import { allowedToolsForAgent, executeMcpTool } from "@/lib/mcp/service";
import { credentialSecretStrings, getToolByFullName } from "@/lib/mcp/store";
import { maskSecretArgs, runGuarded, type GuardInfo, type SideEffectClass } from "@/lib/guard";
import { TURN_BUDGET } from "@/lib/runtime/budget";
import { getToolServer, resolveTurnToken, type InternalToolDef, type ToolCallContext } from "./internal";

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Explicit per-tool overrides (owner / Capability Manager) stored in the DB. */
export function toolOverride(fullName: string): SideEffectClass | null {
  return readDb().toolPolicies?.find((p) => p.fullName === fullName)?.class ?? null;
}

export { maskSecretArgs };

/** Replace the declared-sensitive arguments of one tool before the call is recorded. */
function maskDeclared(args: Record<string, unknown>, keys?: string[]): Record<string, unknown> {
  if (!keys?.length) return args;
  const out = { ...args };
  for (const k of keys) if (typeof out[k] === "string" && out[k]) out[k] = "•••";
  return out;
}

function scrubArgs(args: Record<string, unknown>, secrets: string[]): string {
  let s = JSON.stringify(maskSecretArgs(args ?? {}));
  for (const x of secrets) if (x && x.length >= 4) while (s.includes(x)) s = s.split(x).join("•••");
  return s.slice(0, 500);
}

/**
 * Execute one tool (internal server or MCP) for an agent turn through the
 * side-effect guard, recording activity. Never throws.
 */
/** steps taken per task, so a long-running turn can warn the owner before it hits the ceiling */
const stepCount = new Map<string, number>();

function countStep(agent: AgentRecord, scopeId: string): void {
  const n = (stepCount.get(scopeId) ?? 0) + 1;
  stepCount.set(scopeId, n);
  if (stepCount.size > 500) stepCount.delete(stepCount.keys().next().value as string);
  if (n !== TURN_BUDGET.warnAt) return;
  // heads-up only: the task keeps going, nothing is blocked
  void import("@/lib/owner-actions/notify")
    .then(({ notifyOwner }) =>
      notifyOwner({
        title: `${agent.name} is on a long task`,
        body: `${n} steps so far. It keeps working; you will only be asked if it reaches ${TURN_BUDGET.approveAt}.`,
        href: `/agents/${agent.id}`,
        dedupeKey: `turn_warn:${scopeId}`,
      }),
    )
    .catch(() => undefined);
}

export async function runTool(agent: AgentRecord, ctx: ToolCallContext, fullName: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
  const started = Date.now();
  const i = fullName.indexOf("__");
  const slug = i > 0 ? fullName.slice(0, i) : "";
  const toolName = i > 0 ? fullName.slice(i + 2) : fullName;
  const scopeId = ctx.scopeId ?? `turn:${ctx.turnId}`;
  countStep(agent, scopeId);

  // ---- internal tool server
  const server = getToolServer(slug);
  if (server) {
    const def = (server.toolsFor?.(agent) ?? server.tools).find((t) => t.name === toolName);
    if (!def) return { server: server.name, tool: toolName, args, ok: false, result: "", error: `Unknown or not permitted tool ${toolName} on ${server.name}.`, durationMs: 0 };
    // values of declared-sensitive arguments are scrubbed everywhere they would be written
    const masked = (def.maskArgs ?? []).map((k) => (typeof args?.[k] === "string" ? (args[k] as string) : "")).filter((v) => v.length >= 4);
    const evId = server.selfRecords ? null : ctx.emit.start("tool", toolName, scrubArgs(args, masked), server.name);
    const r = await runGuarded({
      scopeId, agentId: agent.id, toolSource: "internal", serverName: server.name, toolName, toolIdentity: `${server.slug}.${toolName}`,
      description: def.description, override: def.sideEffect ?? "READ_ONLY", inputSchema: def.inputSchema, args, secrets: masked, sensitiveResult: def.sensitive,
      exec: async (a) => {
        const out = await server.call(toolName, a, ctx);
        return { ok: out.ok, text: out.text, images: out.images };
      },
    });
    // a sensitive result (payment details) is shown to the agent only; nothing of it is recorded
    const shown = def.sensitive && r.ok ? "(sensitive result released to the agent — not recorded)" : r.text.slice(0, 2000);
    if (evId) ctx.emit.finish(evId, "tool", toolName, { output: shown, meta: server.name, status: r.ok ? "done" : "failed", guard: r.guard });
    return { server: server.name, tool: toolName, args: maskSecretArgs(maskDeclared(args, def.maskArgs)), ok: r.ok, result: r.ok ? r.text : "", error: r.ok ? undefined : r.text, durationMs: Date.now() - started, images: r.images, guard: r.guard, sensitive: def.sensitive };
  }

  // ---- MCP tool (grant enforced by executeMcpTool as before)
  const found = getToolByFullName(fullName);
  const serverName = found?.server.name ?? slug;
  const secrets = found ? credentialSecretStrings(found.server.credentialId) : [];
  const evId = ctx.emit.start("tool", found?.tool.name ?? toolName, scrubArgs(args, secrets), serverName);
  const r = await runGuarded({
    scopeId, agentId: agent.id, toolSource: "mcp", serverName, toolName: found?.tool.name ?? toolName, toolIdentity: `${slug}.${found?.tool.name ?? toolName}`,
    description: found?.tool.description, annotations: found?.tool.annotations ?? null, override: toolOverride(fullName), inputSchema: found?.tool.inputSchema, args, secrets,
    exec: async (a) => {
      const rec = await executeMcpTool(agent, fullName, a);
      return { ok: rec.ok, text: rec.ok ? rec.result : rec.error ?? "The MCP tool reported an error." };
    },
  });
  ctx.emit.finish(evId, "tool", found?.tool.name ?? toolName, { output: r.text.slice(0, 2000), meta: serverName, status: r.ok ? "done" : "failed", guard: r.guard });
  return { server: serverName, tool: found?.tool.name ?? toolName, args, ok: r.ok, result: r.ok ? r.text : "", error: r.ok ? undefined : r.text, durationMs: Date.now() - started, guard: r.guard };
}

/* ---------------------------------------------------------------- proxy entry points (CLI runtimes) */

function agentFor(ctx: ToolCallContext): AgentRecord | null {
  return readDb().agents.find((a) => a.id === ctx.agentId) ?? null;
}

/** Tools the proxy for `slug` should list: an internal server's tools, or the agent's granted tools on that MCP server. */
export function listInternalTools(token: string | undefined, slug: string): InternalToolDef[] | null {
  const grant = resolveTurnToken(token);
  if (!grant || !grant.servers.includes(slug)) return null;
  const agent = agentFor(grant.ctx);
  if (!agent) return null;
  const internal = getToolServer(slug);
  if (internal) return internal.toolsFor?.(agent) ?? internal.tools;
  return allowedToolsForAgent(agent)
    .filter((t) => t.serverSlug === slug)
    .map((t) => ({ name: t.toolName, description: t.description, inputSchema: { type: "object" as const, properties: (t.inputSchema?.properties ?? {}) as Record<string, unknown>, required: t.inputSchema?.required } }));
}

export async function callInternalTool(token: string | undefined, slug: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: ToolContent[]; error?: string; guard?: GuardInfo }> {
  const grant = resolveTurnToken(token);
  if (!grant) return { ok: false, content: [{ type: "text", text: "This turn is no longer authorized to call Nexora tools." }], error: "Bad or expired turn token." };
  if (!grant.servers.includes(slug)) return { ok: false, content: [{ type: "text", text: `Tool server ${slug} is not available to this agent.` }], error: "Server not granted." };
  const agent = agentFor(grant.ctx);
  if (!agent) return { ok: false, content: [{ type: "text", text: "Agent not found." }], error: "Agent not found." };
  const internal = getToolServer(slug);
  let fullName: string;
  if (internal) {
    if (!(internal.toolsFor?.(agent) ?? internal.tools).some((t) => t.name === name)) return { ok: false, content: [{ type: "text", text: `Unknown tool ${name}.` }], error: "Unknown tool." };
    fullName = `${slug}__${name}`;
  } else {
    const t = allowedToolsForAgent(agent).find((x) => x.serverSlug === slug && x.toolName === name);
    if (!t) return { ok: false, content: [{ type: "text", text: `Tool ${name} on ${slug} is not granted to this agent.` }], error: "Tool not granted." };
    fullName = t.fullName;
  }
  const rec = await runTool(agent, grant.ctx, fullName, args ?? {});
  const content: ToolContent[] = [];
  for (const img of rec.images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  content.push({ type: "text", text: rec.ok ? rec.result || "ok" : rec.error || "error" });
  return { ok: rec.ok, content, guard: rec.guard };
}

/** AllowedTool views for an agent's granted MCP tools (used to build the proxy servers). */
export function grantedMcpTools(agent: AgentRecord): AllowedTool[] {
  return allowedToolsForAgent(agent);
}
