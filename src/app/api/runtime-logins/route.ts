export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { claudeStatus, codexStatus, listSessions } from "@/lib/runtime/logins";

export async function GET() {
  const [claudeCode, codex] = await Promise.all([claudeStatus(), codexStatus()]);
  return NextResponse.json({ status: { "claude-code": claudeCode, codex }, sessions: listSessions() });
}
