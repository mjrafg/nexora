export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { findRequest, listCapabilityActivity } from "@/lib/capabilities/store";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = findRequest(id);
  if (!r) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  return NextResponse.json({ request: r, activity: listCapabilityActivity(100, r.id) });
}
