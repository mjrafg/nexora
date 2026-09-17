export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cancelCompanyInfoRequest, resolveCompanyInfoRequest } from "@/lib/company/service";
import { jsonError, readJson } from "@/lib/api-helpers";
import "@/lib/tools/servers";

type Ctx = { params: Promise<{ id: string }> };

/** { action: "resolve" } marks a request provided (and resumes the agent); { action: "cancel" } dismisses it. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { action } = await readJson<{ action?: string }>(req);
    const request = action === "cancel" ? cancelCompanyInfoRequest(id) : await resolveCompanyInfoRequest(id, "owner");
    return NextResponse.json({ request });
  } catch (err) {
    return jsonError(err);
  }
}
