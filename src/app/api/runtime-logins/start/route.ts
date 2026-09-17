export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { startLogin, type LoginRuntime } from "@/lib/runtime/logins";
import { jsonError, readJson } from "@/lib/api-helpers";

export async function POST(req: Request) {
  try {
    const body = await readJson<{ runtime?: LoginRuntime }>(req);
    if (body.runtime !== "claude-code" && body.runtime !== "codex") throw new Error("runtime must be claude-code or codex");
    return NextResponse.json({ session: startLogin(body.runtime) });
  } catch (err) {
    return jsonError(err);
  }
}
