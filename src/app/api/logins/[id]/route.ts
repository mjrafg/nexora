export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { deleteLoginCredential, toView, updateLoginCredential } from "@/lib/credentials/store";
import { jsonError, readJson, str } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = await readJson<Record<string, unknown>>(req);
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "service", "site", "description", "username", "password"]) if (typeof b[k] === "string" && (b[k] as string).trim()) patch[k] = b[k];
    if (typeof b.loginUrl === "string") patch.loginUrl = b.loginUrl;
    if (b.type) patch.type = b.type;
    if (b.status === "AVAILABLE" || b.status === "DISABLED") patch.status = b.status;
    return NextResponse.json({ credential: toView(updateLoginCredential(id, patch, "owner")) });
  } catch (err) {
    return jsonError(err, str(err instanceof Error ? err.message : "") === "Credential not found." ? 404 : 400);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    deleteLoginCredential(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
