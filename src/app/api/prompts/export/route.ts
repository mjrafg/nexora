export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promptViews } from "@/lib/prompts";
import { exportFileName, exportPrompts } from "@/lib/prompts/exchange";
import { jsonError, readJson, strList } from "@/lib/api-helpers";

/**
 * A downloadable prompt file: everything, one category, a selection, or one
 * prompt. The body decides which; the response is the file.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ ids?: string[]; category?: string }>(req);
    let ids = strList(body.ids) ?? undefined;
    if (!ids?.length && body.category) ids = promptViews().filter((p) => p.category === body.category).map((p) => p.id);
    const file = exportPrompts(ids);
    return new NextResponse(JSON.stringify(file, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${exportFileName()}"`,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
