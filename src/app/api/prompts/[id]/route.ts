export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { PromptError, promptDef, promptRevisions, promptView, resetPrompt, restoreRevision, savePromptOverride } from "@/lib/prompts";
import { jsonError, readJson, str } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const def = promptDef(id);
  if (!def) return NextResponse.json({ error: "No prompt with that id" }, { status: 404 });
  return NextResponse.json({ prompt: promptView(def), revisions: promptRevisions(id) });
}

/**
 * The owner's three moves on one prompt: replace its text, put the built-in
 * back, or restore something they had before.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!promptDef(id)) return NextResponse.json({ error: "No prompt with that id" }, { status: 404 });
    const body = await readJson<{ content?: string; reset?: boolean; revisionId?: string }>(req);
    const prompt = body.reset
      ? resetPrompt(id)
      : body.revisionId
        ? restoreRevision(str(body.revisionId, 80) ?? "")
        : savePromptOverride(id, body.content ?? "");
    return NextResponse.json({ prompt, revisions: promptRevisions(id) });
  } catch (err) {
    return jsonError(err, err instanceof PromptError ? 400 : 500);
  }
}
