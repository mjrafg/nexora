export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { submitCode } from "@/lib/runtime/logins";
import { jsonError, readJson, str } from "@/lib/api-helpers";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await readJson<{ code?: string }>(req);
    const code = str(body.code, 2000)?.trim();
    if (!code) throw new Error("Code is required");
    return NextResponse.json({ session: submitCode(id, code) });
  } catch (err) {
    return jsonError(err);
  }
}
