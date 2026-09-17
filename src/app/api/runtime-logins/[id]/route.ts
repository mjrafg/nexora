export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSession } from "@/lib/runtime/logins";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: "Login session not found" }, { status: 404 });
  return NextResponse.json({ session });
}
