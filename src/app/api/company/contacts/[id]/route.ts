export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getProfile, removeContact, toProfileView, updateContact } from "@/lib/company/store";
import { resolveFilledRequests } from "@/lib/company/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import "@/lib/tools/servers";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = await readJson<Record<string, unknown>>(req);
    const contact = updateContact(id, {
      type: b.type === "PHONE" ? "PHONE" : b.type === "EMAIL" ? "EMAIL" : undefined,
      name: str(b.name, 80),
      value: str(b.value, 200),
      description: str(b.description, 600),
      isPrimary: typeof b.isPrimary === "boolean" ? b.isPrimary : undefined,
      status: b.status === "ACTIVE" || b.status === "INACTIVE" ? b.status : undefined,
    });
    const resolved = await resolveFilledRequests();
    return NextResponse.json({ contact, profile: toProfileView(getProfile()), resolved });
  } catch (err) {
    return jsonError(err);
  }
}

/** Owner only — agents never change company contact information. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    removeContact(id);
    return NextResponse.json({ ok: true, profile: toProfileView(getProfile()) });
  } catch (err) {
    return jsonError(err);
  }
}
