export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cancelOwnerAction, resolveOwnerAction } from "@/lib/owner-actions/service";
import { getOwnerAction, openOwnerActionCount } from "@/lib/owner-actions/store";
import { markViewed } from "@/lib/owner-actions/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import "@/lib/tools/servers";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const action = getOwnerAction(decodeURIComponent(id));
  if (!action) return NextResponse.json({ error: "Action not found" }, { status: 404 });
  markViewed(action.id);
  return NextResponse.json({ action });
}

/** The owner answered: submit values, pick a choice, or dismiss it. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = await readJson<Record<string, unknown>>(req);
    const actionId = decodeURIComponent(id);
    const dismiss = b.dismiss === true;
    const action = dismiss
      ? await cancelOwnerAction(actionId, str(b.note, 500))
      : await resolveOwnerAction(actionId, {
          choice: str(b.choice, 60),
          values: (b.values && typeof b.values === "object" ? b.values : {}) as Record<string, string>,
          save: (b.save && typeof b.save === "object" ? b.save : {}) as Record<string, boolean>,
          note: str(b.note, 500),
        });
    return NextResponse.json({ action, counts: openOwnerActionCount() });
  } catch (err) {
    return jsonError(err);
  }
}
