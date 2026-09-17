export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listRequests } from "@/lib/payments/store";
import { createPaymentRequest } from "@/lib/payments/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import "@/lib/tools/servers";

export async function GET() {
  return NextResponse.json({ requests: listRequests() });
}

/** Owner/test entry: file a payment request on behalf of an agent (agents normally call request_payment). */
export async function POST(req: Request) {
  try {
    const b = await readJson<{ agentId?: string; merchant?: string; amount?: number; reason?: string; billingType?: string; interval?: string; preferredMethod?: string; recommendation?: string }>(req);
    const agentId = str(b.agentId, 100)?.trim();
    if (!agentId) throw new RuntimeError("agentId is required");
    const request = createPaymentRequest({
      agentId, merchant: str(b.merchant, 120) ?? "", amount: Number(b.amount), reason: str(b.reason, 1_000) ?? "",
      billingType: b.billingType === "RECURRING" ? "RECURRING" : "ONE_TIME", interval: b.interval === "YEARLY" ? "YEARLY" : b.interval === "MONTHLY" ? "MONTHLY" : undefined,
      preferredMethod: b.preferredMethod === "CARD" || b.preferredMethod === "BANK_ACCOUNT" ? b.preferredMethod : "ANY", recommendation: str(b.recommendation, 600),
    });
    return NextResponse.json({ request }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
