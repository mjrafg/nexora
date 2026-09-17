export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import { listDir, makeDir, quickLinks } from "@/lib/fs-browse";

/** Browse folders on this machine, so work can be pinned to one. Owner only (the app is behind login). */
export async function GET(req: Request) {
  try {
    const asked = new URL(req.url).searchParams.get("path");
    if (!asked) return NextResponse.json({ quickLinks: quickLinks() });
    return NextResponse.json({ listing: listDir(asked) });
  } catch (err) {
    return jsonError(err);
  }
}

/** Create one folder inside an existing one. */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ parent?: string; name?: string }>(req);
    const parent = str(body.parent, 1_000)?.trim();
    const name = str(body.name, 100)?.trim();
    if (!parent || !name) throw new RuntimeError("Both a parent folder and a name are required");
    return NextResponse.json({ created: makeDir(parent, name) }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
