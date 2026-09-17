export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { findRequest } from "@/lib/payments/store";
import { approvePaymentRequest, cancelPaymentRequest, rejectPaymentRequest, resolveException } from "@/lib/payments/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import "@/lib/tools/servers";

/** Owner decision: cancel */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const r = findRequest(id);
    if (!r) throw new RuntimeError("Payment request not found");
    const body = await readJson<{ paymentMethodId?: string | null; note?: string; status?: string }>(req);
    const note = str(body.note, 500)?.trim() || undefined;
    const op = "cancel" as string;
    const request =
      op === "approve" ? await approvePaymentRequest(r.id, body.paymentMethodId ?? null, note)
      : op === "reject" ? await rejectPaymentRequest(r.id, note)
      : op === "cancel" ? cancelPaymentRequest(r.id, "owner", note)
      : resolveException(r.id, body.status === "FAILED" ? "FAILED" : "SUCCEEDED", note);
    return NextResponse.json({ request });
  } catch (err) {
    return jsonError(err);
  }
}
