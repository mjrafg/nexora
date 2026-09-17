export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { findRequest } from "@/lib/capabilities/store";
import { discussRequest } from "@/lib/capabilities/manager";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import "@/lib/tools/servers";

/** Owner discusses a request with the Capability Manager (its reply lands in the manager's chat). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const r = findRequest(id);
    if (!r) throw new RuntimeError("Request not found");
    const body = await readJson<{ message?: string }>(req);
    const text = str(body.message, 20_000)?.trim();
    if (!text) throw new RuntimeError("message is required");
    const reply = await discussRequest(r.id, text);
    return NextResponse.json({ reply, request: findRequest(r.id) });
  } catch (err) {
    return jsonError(err);
  }
}
