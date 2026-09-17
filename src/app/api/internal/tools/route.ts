export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { callInternalTool, listInternalTools } from "@/lib/tools/runner";
import "@/lib/tools/servers";

/**
 * Turn-token-authenticated callback used by the generic stdio proxy
 * (scripts/mcp-nexora.mjs). The token names the agent and the servers that
 * turn may use — nothing in the body is trusted for identity.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; server?: string; op?: string; name?: string; args?: Record<string, unknown> };
  const server = String(body.server ?? "");
  if (body.op === "list") {
    const tools = listInternalTools(body.token, server);
    if (!tools) return NextResponse.json({ error: "Bad turn token or server not granted." }, { status: 403 });
    return NextResponse.json({ tools });
  }
  if (body.op === "call") {
    const r = await callInternalTool(body.token, server, String(body.name ?? ""), body.args ?? {});
    if (r.error && /token/i.test(r.error)) return NextResponse.json({ error: r.error }, { status: 403 });
    return NextResponse.json(r);
  }
  return NextResponse.json({ error: "op must be list or call." }, { status: 400 });
}
