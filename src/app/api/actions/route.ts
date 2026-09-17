export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listExecutions } from "@/lib/guard";

/** Action Execution Ledger (audit): side-effect executions, newest first. Never contains secrets. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const scopeId = u.searchParams.get("scopeId") ?? undefined;
  const agentId = u.searchParams.get("agentId") ?? undefined;
  const limit = Math.min(Number(u.searchParams.get("limit") ?? 200) || 200, 1000);
  return NextResponse.json({ executions: listExecutions({ scopeId, agentId, limit }) });
}
