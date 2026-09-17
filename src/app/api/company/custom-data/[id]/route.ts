export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { deleteCustomDatum, patchCustomDatum, SecretRejected } from "@/lib/company/custom-data";
import { resolveFilledRequests } from "@/lib/company/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import "@/lib/tools/servers";

type Ctx = { params: Promise<{ id: string }> };

/** Owner edit — this is also how a provisional value becomes verified. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = await readJson<Record<string, unknown>>(req);
    const datum = patchCustomDatum(id, {
      key: str(b.key, 120),
      value: b.value,
      valueType: str(b.valueType, 20) as never,
      label: str(b.label, 120),
      description: str(b.description, 600),
      status: b.status === "verified" ? "verified" : b.status === "provisional" ? "provisional" : undefined,
    });
    const resolved = await resolveFilledRequests();
    return NextResponse.json({ datum, resolved });
  } catch (err) {
    return jsonError(err, err instanceof SecretRejected ? 422 : 400);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    deleteCustomDatum(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
