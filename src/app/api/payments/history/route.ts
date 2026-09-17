export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listTransactions } from "@/lib/payments/store";

export async function GET() {
  return NextResponse.json({ transactions: listTransactions(1000) });
}
