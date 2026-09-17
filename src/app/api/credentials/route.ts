export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createCredential, listCredentials } from "@/lib/mcp/store";
import { jsonError, readJson, str } from "@/lib/api-helpers";

export async function GET() {
  return NextResponse.json({ credentials: listCredentials() });
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ name?: string; values?: Record<string, string> }>(req);
    const name = str(body.name, 80) ?? "";
    return NextResponse.json({ credential: createCredential(name, body.values ?? {}) }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
