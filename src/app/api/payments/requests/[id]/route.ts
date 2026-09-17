export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { findRequest, listTransactions } from "@/lib/payments/store";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const request = findRequest(id);
  if (!request) return NextResponse.json({ error: "Payment request not found" }, { status: 404 });
  const transaction = listTransactions(5000).find((t) => t.paymentRequestId === request.id) ?? null;
  return NextResponse.json({ request, transaction });
}
