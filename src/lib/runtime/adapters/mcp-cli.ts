/* ------------------------------------------------------------------
   Hand an agent's permitted MCP servers to the external CLIs (Claude Code,
   Codex) using each CLI's own MCP support, with resolved secrets written to
   a temp file (0600) rather than the command line. Nothing here modifies the
   user's real config; temp files are removed after the call.
   ------------------------------------------------------------------ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const BRIDGE = path.join(process.cwd(), "scripts", "mcp-http-bridge.mjs");

/** Resolved headers (incl. OAuth bearer) for an http server, for the stdio bridge. */
async function httpHeaders(server: NonNullable<ReturnType<typeof getServer>>, spec: { headers: Record<string, string> }): Promise<Record<string, string>> {
  const headers = { ...spec.headers };
  if (server.oauth?.connected) {
    const token = await validAccessToken(server);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
import { getServer, serverLaunchSpec } from "@/lib/mcp";
import { validAccessToken } from "@/lib/mcp/oauth";
import type { AllowedTool } from "@/lib/mcp/types";
import type { ExtraMcpServer } from "@/lib/runtime/types";

function uniqueServerIds(tools: AllowedTool[]): string[] {
  return [...new Set(tools.map((t) => t.serverId))];
}

/** Claude Code: temp --mcp-config JSON + the mcp__<slug>__<tool> allow patterns. */
export async function buildClaudeMcp(tools: AllowedTool[], extra: ExtraMcpServer[] = []): Promise<{ configPath: string; allowed: string[]; cleanup: () => void } | null> {
  if (tools.length === 0 && extra.length === 0) return null;
  const mcpServers: Record<string, unknown> = {};
  for (const id of uniqueServerIds(tools)) {
    const server = getServer(id);
    if (!server) continue;
    const spec = serverLaunchSpec(server);
    if (spec.transport === "http") {
      // Bridge remote HTTP MCP over stdio so the CLI never wrestles with SSE/OAuth transports.
      const headers = await httpHeaders(server, spec);
      mcpServers[server.slug] = {
        command: process.execPath,
        args: [BRIDGE],
        env: { MCP_URL: spec.url, MCP_HEADERS: JSON.stringify(headers) },
      };
    } else {
      mcpServers[server.slug] = { command: spec.command, args: spec.args, ...(Object.keys(spec.env).length ? { env: spec.env } : {}) };
    }
  }
  for (const x of extra) mcpServers[x.slug] = { command: x.command, args: x.args, env: x.env };
  if (Object.keys(mcpServers).length === 0) return null;
  const configPath = path.join(os.tmpdir(), `nexora-mcp-${process.pid}-${randomUUID().slice(0, 8)}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  const allowed = [...tools.map((t) => `mcp__${t.serverSlug}__${t.toolName}`), ...extra.flatMap((x) => x.tools.map((t) => `mcp__${x.slug}__${t}`))];
  return { configPath, allowed, cleanup: () => { try { fs.unlinkSync(configPath); } catch { /* gone */ } } };
}

/**
 * Codex: a throwaway CODEX_HOME that reuses the real login (auth.json) and
 * config, plus the agent's MCP servers. Secrets live only in this temp dir.
 */
export async function buildCodexHome(tools: AllowedTool[], realHome: string, extra: ExtraMcpServer[] = []): Promise<{ codexHome: string; cleanup: () => void } | null> {
  const ids = uniqueServerIds(tools);
  if (ids.length === 0 && extra.length === 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-codex-"));
  // reuse the existing login without copying secrets we don't own
  for (const f of ["auth.json"]) {
    const src = path.join(realHome, f);
    if (fs.existsSync(src)) {
      try { fs.symlinkSync(src, path.join(dir, f)); } catch { try { fs.copyFileSync(src, path.join(dir, f)); } catch { /* ignore */ } }
    }
  }
  const lines: string[] = [];
  const baseConfig = path.join(realHome, "config.toml");
  if (fs.existsSync(baseConfig)) {
    // keep the user's model/provider defaults but not their notify hooks
    const txt = fs.readFileSync(baseConfig, "utf8");
    const modelLine = txt.match(/^\s*model\s*=.*$/m)?.[0];
    if (modelLine) lines.push(modelLine);
  }
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  for (const id of ids) {
    const server = getServer(id);
    if (!server) continue;
    const spec = serverLaunchSpec(server);
    lines.push(`[mcp_servers.${server.slug}]`);
    if (spec.transport === "http") {
      // Bridge remote HTTP MCP over stdio (Codex speaks stdio MCP reliably).
      const headers = await httpHeaders(server, spec);
      lines.push(`command = "${esc(process.execPath)}"`);
      lines.push(`args = ["${esc(BRIDGE)}"]`);
      lines.push(`env = { "MCP_URL" = "${esc(spec.url)}", "MCP_HEADERS" = "${esc(JSON.stringify(headers))}" }`);
    } else {
      lines.push(`command = "${esc(spec.command)}"`);
      lines.push(`args = [${spec.args.map((a) => `"${esc(a)}"`).join(", ")}]`);
      const envEntries = Object.entries(spec.env);
      if (envEntries.length) lines.push(`env = { ${envEntries.map(([k, v]) => `"${esc(k)}" = "${esc(v)}"`).join(", ")} }`);
    }
  }
  for (const x of extra) {
    lines.push(`[mcp_servers.${x.slug}]`);
    lines.push(`command = "${esc(x.command)}"`);
    lines.push(`args = [${x.args.map((a) => `"${esc(a)}"`).join(", ")}]`);
    const envEntries = Object.entries(x.env);
    if (envEntries.length) lines.push(`env = { ${envEntries.map(([k, v]) => `"${esc(k)}" = "${esc(v)}"`).join(", ")} }`);
  }
  fs.writeFileSync(path.join(dir, "config.toml"), lines.join("\n") + "\n", { mode: 0o600 });
  return { codexHome: dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } } };
}
