export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { deleteCredential, updateCredential } from "@/lib/mcp/store";
import { jsonError, readJson, str } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJson<{ name?: string; values?: Record<string, string> }>(req);
    return NextResponse.json({ credential: updateCredential(id, { name: str(body.name, 80), values: body.values }) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    deleteCredential(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
