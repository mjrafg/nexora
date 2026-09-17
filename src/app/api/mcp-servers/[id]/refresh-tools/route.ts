export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServer } from "@/lib/mcp/store";
import { discoverTools, mcpDisconnect } from "@/lib/mcp/service";
import { toServerView } from "@/lib/mcp/views";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const server = getServer(id);
  if (!server) return NextResponse.json({ error: "Server not found" }, { status: 404 });
  mcpDisconnect(id);
  const result = await discoverTools(server);
  return NextResponse.json({ ...result, server: toServerView(getServer(id)!) });
}
