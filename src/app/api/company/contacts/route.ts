export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { addContact, getProfile, toProfileView } from "@/lib/company/store";
import { resolveFilledRequests } from "@/lib/company/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import "@/lib/tools/servers";

/** Owner adds a company contact method (email or phone) with its purpose description. */
export async function POST(req: Request) {
  try {
    const b = await readJson<Record<string, unknown>>(req);
    const contact = addContact({
      type: b.type === "PHONE" ? "PHONE" : "EMAIL",
      name: str(b.name, 80) ?? "",
      value: str(b.value, 200) ?? "",
      description: str(b.description, 600) ?? "",
      isPrimary: typeof b.isPrimary === "boolean" ? b.isPrimary : undefined,
    });
    const resolved = await resolveFilledRequests();
    return NextResponse.json({ contact, profile: toProfileView(getProfile()), resolved }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
