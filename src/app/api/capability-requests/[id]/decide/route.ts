export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { findRequest } from "@/lib/capabilities/store";
import { decidePayment } from "@/lib/capabilities/manager";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import "@/lib/tools/servers";

/** Owner decision on a payment approval: approve or reject (with an optional note). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const r = findRequest(id);
    if (!r) throw new RuntimeError("Request not found");
    const body = await readJson<{ decision?: string; note?: string }>(req);
    if (body.decision !== "approved" && body.decision !== "rejected") throw new RuntimeError("decision must be approved or rejected");
    const updated = decidePayment(r.id, body.decision, str(body.note, 2_000)?.trim() || undefined);
    return NextResponse.json({ request: updated });
  } catch (err) {
    return jsonError(err);
  }
}
