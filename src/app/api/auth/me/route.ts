export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, readAuthConfig, verifySessionToken } from "@/lib/auth";

export async function GET() {
  const cfg = readAuthConfig();
  const session = verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, cfg);
  if (!session) return NextResponse.json({ user: null, configured: !!cfg }, { status: 401 });
  return NextResponse.json({ user: { username: session.username }, configured: true });
}
