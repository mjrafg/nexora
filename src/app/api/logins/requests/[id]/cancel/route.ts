export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cancelCredentialRequest } from "@/lib/credentials/service";
import { jsonError } from "@/lib/api-helpers";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ request: cancelCredentialRequest(id) });
  } catch (err) {
    return jsonError(err);
  }
}
