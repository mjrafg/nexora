export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServer } from "@/lib/mcp/store";
import { disconnectOAuth } from "@/lib/mcp/oauth";
import { mcpDisconnect } from "@/lib/mcp/service";
import { toServerView } from "@/lib/mcp/views";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getServer(id)) return NextResponse.json({ error: "Server not found" }, { status: 404 });
  disconnectOAuth(id);
  mcpDisconnect(id);
  return NextResponse.json({ ok: true, server: toServerView(getServer(id)!) });
}
