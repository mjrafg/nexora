export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cancelSession, getSession } from "@/lib/runtime/logins";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  cancelSession(id);
  return NextResponse.json({ session: getSession(id) });
}
