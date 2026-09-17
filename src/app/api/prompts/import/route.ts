export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { applicableIds, applyImport, previewImport } from "@/lib/prompts/exchange";
import { jsonError, readJson, strList } from "@/lib/api-helpers";

/**
 * Two steps, always in this order: say what would change, then change only
 * what the owner ticked. There is no one-shot import on purpose.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ file?: unknown; apply?: string[] }>(req);
    const preview = previewImport(body.file);
    if (!preview.ok) return NextResponse.json({ preview }, { status: 400 });
    if (!body.apply) return NextResponse.json({ preview, suggested: applicableIds(preview) });
    const result = applyImport(body.file, strList(body.apply) ?? []);
    return NextResponse.json({ preview: previewImport(body.file), result });
  } catch (err) {
    return jsonError(err);
  }
}
