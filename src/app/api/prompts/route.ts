export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { CATEGORY_LABELS, PROMPT_CATEGORIES, promptViews } from "@/lib/prompts";
import { promptCounts } from "@/lib/prompts/exchange";

/** Every static prompt Nexora uses, with what it resolves to right now. */
export async function GET() {
  const prompts = promptViews();
  return NextResponse.json({
    prompts,
    counts: promptCounts(prompts),
    categories: PROMPT_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id], count: prompts.filter((p) => p.category === id).length })),
  });
}
