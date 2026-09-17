export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { deleteServer, getServer, updateServer } from "@/lib/mcp/store";
import { mcpDisconnect } from "@/lib/mcp/service";
import { toServerView } from "@/lib/mcp/views";
import { normalizeConfig } from "../route";
import { jsonError, readJson, str } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const server = getServer(id);
  if (!server) return NextResponse.json({ error: "Server not found" }, { status: 404 });
  return NextResponse.json({ server: toServerView(server) });
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const cur = getServer(id);
    if (!cur) return NextResponse.json({ error: "Server not found" }, { status: 404 });
    const body = await readJson<{ name?: string; config?: unknown; credentialId?: string | null; enabled?: boolean }>(req);
    const patch: Parameters<typeof updateServer>[1] = {};
    if (body.name !== undefined) patch.name = str(body.name, 80);
    if (body.config !== undefined) patch.config = normalizeConfig(body.config);
    if (body.credentialId !== undefined) patch.credentialId = body.credentialId;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    const updated = updateServer(id, patch);
    if (body.config !== undefined || body.credentialId !== undefined) mcpDisconnect(id);
    return NextResponse.json({ server: toServerView(updated) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getServer(id)) return NextResponse.json({ error: "Server not found" }, { status: 404 });
  mcpDisconnect(id);
  deleteServer(id);
  return NextResponse.json({ ok: true });
}
