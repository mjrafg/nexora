export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { overview } from "@/lib/payments/service";
import { listMethods, listRequests, listTransactions } from "@/lib/payments/store";

export async function GET() {
  return NextResponse.json({
    overview: overview(),
    recent: listTransactions(8),
    pending: listRequests().filter((r) => r.status === "WAITING_FOR_APPROVAL" || !!r.exception),
    methods: listMethods(),
  });
}
