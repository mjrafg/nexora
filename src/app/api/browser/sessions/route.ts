export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cancelBrowser, listBrowserSessions, releaseBrowser } from "@/lib/browser/host";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";

export async function GET() {
  return NextResponse.json({ sessions: listBrowserSessions() });
}

/** Session lifecycle from the UI: cancel (tear down the live browser now), release (close, keep saved state), delete (erase saved state too). */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ id?: string; action?: string }>(req);
    const id = str(body.id, 200)?.trim();
    if (!id) throw new RuntimeError("id is required");
    if (body.action === "cancel") return NextResponse.json({ ok: true, cancelled: await cancelBrowser(id) });
    if (body.action === "delete") { await releaseBrowser(id, { deleteDurable: true }); return NextResponse.json({ ok: true }); }
    await releaseBrowser(id, { deleteDurable: false });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
