/* ------------------------------------------------------------------
   MCP service layer: connection testing, tool discovery, resolving an
   agent's allowed tools, and executing a tool with secret scrubbing.
   Failures are always isolated — a broken server never throws past here.
   ------------------------------------------------------------------ */

import type { AgentRecord } from "@/lib/runtime/types";
import { mcpCallTool, mcpDisconnect, mcpListTools } from "./client";
import {
  credentialSecretStrings,
  getServer,
  getToolByFullName,
  markMissingExcept,
  recordServerTest,
  toolsForServer,
  upsertTool,
} from "./store";
import type { AllowedTool, McpServerRecord, McpTestResult, ToolCallRecord } from "./types";

export { mcpDisconnect };

const RESULT_LIMIT = 20_000;

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) while (out.includes(s)) out = out.split(s).join("•••");
  }
  return out;
}

/** Test a server by listing its tools. Never throws. */
export async function testServer(server: McpServerRecord): Promise<McpTestResult> {
  const started = Date.now();
  try {
    const tools = await mcpListTools(server);
    recordServerTest(server.id, true);
    return { ok: true, message: "Connected", detail: `The server reports ${tools.length} tool${tools.length === 1 ? "" : "s"}.`, toolCount: tools.length, durationMs: Date.now() - started };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordServerTest(server.id, false, detail);
    return { ok: false, message: "Connection failed", detail, durationMs: Date.now() - started };
  }
}

/** Discover tools and persist them (preserving grants; missing tools flagged). Never throws. */
export async function discoverTools(server: McpServerRecord): Promise<McpTestResult> {
  const started = Date.now();
  try {
    const tools = await mcpListTools(server);
    const wanted: string[] = [];
    for (const t of tools) {
      const row = upsertTool(server, {
        name: t.name,
        description: String(t.description ?? "").slice(0, 2_000),
        inputSchema: {
          type: "object",
          properties: (t.inputSchema?.properties ?? {}) as Record<string, unknown>,
          required: t.inputSchema?.required ?? [],
        },
        annotations: t.annotations ?? null,
      });
      wanted.push(row.fullName);
    }
    markMissingExcept(server.id, wanted);
    recordServerTest(server.id, true);
    return { ok: true, message: "Connected", detail: `${tools.length} tool${tools.length === 1 ? "" : "s"} discovered.`, toolCount: tools.length, durationMs: Date.now() - started };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordServerTest(server.id, false, detail);
    return { ok: false, message: "Discovery failed", detail, durationMs: Date.now() - started };
  }
}

/** Resolve the concrete set of MCP tools an agent may use, honoring grants. */
export function allowedToolsForAgent(agent: AgentRecord): AllowedTool[] {
  const out: AllowedTool[] = [];
  for (const grant of agent.mcpGrants ?? []) {
    if (!grant.enabled) continue;
    const server = getServer(grant.serverId);
    if (!server || !server.enabled) continue;
    const tools = toolsForServer(server.id).filter((t) => !t.missing);
    for (const t of tools) {
      if (grant.tools !== "all" && !grant.tools.includes(t.fullName)) continue;
      out.push({
        fullName: t.fullName,
        serverId: server.id,
        serverName: server.name,
        serverSlug: server.slug,
        toolName: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }
  }
  return out;
}

/** Execute one MCP tool for an agent. Enforces the grant; scrubs secrets. Never throws. */
export async function executeMcpTool(agent: AgentRecord, fullName: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
  const started = Date.now();
  const allowed = allowedToolsForAgent(agent).find((t) => t.fullName === fullName);
  const found = getToolByFullName(fullName);
  const base: Omit<ToolCallRecord, "ok" | "result" | "durationMs"> = {
    server: found?.server.name ?? "unknown",
    tool: found?.tool.name ?? fullName,
    args,
  };
  if (!allowed || !found) {
    return { ...base, ok: false, result: "", error: `This agent is not permitted to use ${fullName}.`, durationMs: Date.now() - started };
  }
  const secrets = credentialSecretStrings(found.server.credentialId);
  const safeArgs = JSON.parse(scrub(JSON.stringify(args ?? {}), secrets)) as Record<string, unknown>;
  try {
    const { ok, text } = await mcpCallTool(found.server, found.tool.name, args ?? {});
    const result = scrub(text, secrets).slice(0, RESULT_LIMIT);
    return { ...base, args: safeArgs, ok, result: ok ? result : "", error: ok ? undefined : result.slice(0, 2_000) || "The MCP tool reported an error.", durationMs: Date.now() - started };
  } catch (err) {
    const msg = scrub(err instanceof Error ? err.message : String(err), secrets);
    return { ...base, args: safeArgs, ok: false, result: "", error: msg.slice(0, 2_000), durationMs: Date.now() - started };
  }
}
