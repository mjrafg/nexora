export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServer } from "@/lib/mcp/store";
import { startOAuth } from "@/lib/mcp/oauth";
import { jsonError } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ id: string }> };

function originOf(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!getServer(id)) return NextResponse.json({ error: "Server not found" }, { status: 404 });
    const { authorizeUrl, state } = await startOAuth(id, originOf(req));
    return NextResponse.json({ authorizeUrl, state });
  } catch (err) {
    return jsonError(err);
  }
}
