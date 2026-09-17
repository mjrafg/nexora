/* ------------------------------------------------------------------
   Turn bundle: everything an agent may call this turn, routed through the
   Nexora Tool Runner (side-effect guard + activity) on every runtime.

     internal servers (browser, capability requests, manager console)
     + the agent's granted MCP servers

   CLI runtimes get one stdio MCP server per slug (the generic proxy with a
   per-turn token — the CLI never talks to a third-party MCP server
   directly, so the guard sees every call); the API runtime gets the same
   tools in-process. The agent sees identical tool names either way.
   ------------------------------------------------------------------ */

import path from "node:path";
import type { AgentRecord } from "@/lib/runtime/types";
import type { AllowedTool, ToolCallRecord } from "@/lib/mcp/types";
import type { ExtraMcpServer } from "@/lib/runtime/types";
import { issueTurnToken, revokeTurnToken, type InternalToolServer, type ToolCallContext } from "./internal";
import { grantedMcpTools, runTool } from "./runner";

const PROXY = path.join(process.cwd(), "scripts", "mcp-nexora.mjs");

export function internalBaseUrl(): string {
  return process.env.NEXORA_INTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3111}`;
}

export type ToolBundle = {
  /** stdio servers for CLI runtimes (internal + proxied MCP) */
  extraServers: ExtraMcpServer[];
  /** the same tools for the API runtime, executed in-process through the runner */
  tools: AllowedTool[];
  call: (fullName: string, args: Record<string, unknown>) => Promise<ToolCallRecord>;
  /** mcp__<slug>__ prefixes the adapters must not record themselves (the runner records them) */
  silentToolPrefixes: string[];
  release: () => void;
};

export function toolBundle(agent: AgentRecord, ctx: ToolCallContext, servers: InternalToolServer[], opts: { includeGrantedMcp?: boolean } = {}): ToolBundle {
  const mcp = opts.includeGrantedMcp === false ? [] : grantedMcpTools(agent);
  const mcpBySlug = new Map<string, AllowedTool[]>();
  for (const t of mcp) mcpBySlug.set(t.serverSlug, [...(mcpBySlug.get(t.serverSlug) ?? []), t]);
  // an internal server and an MCP server can never share a slug (internal slugs are reserved words)
  for (const s of servers) mcpBySlug.delete(s.slug);

  const slugs = [...servers.map((s) => s.slug), ...mcpBySlug.keys()];
  const token = issueTurnToken(ctx, slugs);
  const env = (slug: string) => ({ NEXORA_INTERNAL_URL: internalBaseUrl(), NEXORA_TURN_TOKEN: token, NEXORA_TOOL_SERVER: slug });

  const extraServers: ExtraMcpServer[] = [
    ...servers.map((s) => ({ slug: s.slug, name: s.name, command: process.execPath, args: [PROXY], env: env(s.slug), tools: (s.toolsFor?.(agent) ?? s.tools).map((t) => t.name) })),
    ...[...mcpBySlug.entries()].map(([slug, tools]) => ({ slug, name: tools[0].serverName, command: process.execPath, args: [PROXY], env: env(slug), tools: tools.map((t) => t.toolName) })),
  ];
  const tools: AllowedTool[] = [
    ...servers.flatMap((s) => (s.toolsFor?.(agent) ?? s.tools).map((t) => ({ fullName: `${s.slug}__${t.name}`, serverId: s.slug, serverName: s.name, serverSlug: s.slug, toolName: t.name, description: t.description, inputSchema: t.inputSchema }))),
    ...[...mcpBySlug.values()].flat(),
  ];
  return {
    extraServers,
    tools,
    call: (fullName, args) => runTool(agent, ctx, fullName, args),
    silentToolPrefixes: slugs.map((s) => `mcp__${s}__`),
    release: () => revokeTurnToken(token),
  };
}
