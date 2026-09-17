export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createServer } from "@/lib/mcp/store";
import { discoverTools } from "@/lib/mcp/service";
import { listServerViews, toServerView } from "@/lib/mcp/views";
import { getServer } from "@/lib/mcp/store";
import type { McpServerConfig } from "@/lib/mcp/types";
import { jsonError, readJson, str, strList } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";

export async function GET() {
  return NextResponse.json({ servers: listServerViews() });
}

export function normalizeConfig(input: unknown): McpServerConfig {
  const c = (input ?? {}) as Record<string, unknown>;
  const transport = c.transport === "http" ? "http" : "stdio";
  if (transport === "http") {
    const url = str(c.url, 2000)?.trim();
    if (!url || !/^https?:\/\//.test(url)) throw new RuntimeError("MCP over HTTP needs a valid http(s) URL.");
    return { transport, url, headers: cleanMap(c.headers) };
  }
  const command = str(c.command, 500)?.trim();
  if (!command) throw new RuntimeError("MCP over stdio needs a command to run.");
  return { transport, command, args: strList(c.args) ?? [], env: cleanMap(c.env) };
}

function cleanMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (String(k).trim() && typeof val === "string") out[String(k).trim()] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ name?: string; config?: unknown; credentialId?: string | null; discover?: boolean }>(req);
    const name = str(body.name, 80)?.trim();
    if (!name) throw new RuntimeError("Server name is required.");
    const config = normalizeConfig(body.config);
    const server = createServer({ name, config, credentialId: body.credentialId ?? null });
    // best-effort discovery on create; failure is reported but the server is kept
    const discovery = body.discover === false ? undefined : await discoverTools(server);
    return NextResponse.json({ server: toServerView(getServer(server.id)!), discovery }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
