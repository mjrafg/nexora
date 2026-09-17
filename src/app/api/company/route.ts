export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listCompanyActivity, listCompanyRequests, requestTarget, toProfileView, updateProfile } from "@/lib/company/store";
import { resolveFilledRequests } from "@/lib/company/service";
import { jsonError, readJson } from "@/lib/api-helpers";
import { getProfile } from "@/lib/company/store";
import "@/lib/tools/servers";

/** The owner's view of the profile. ?reveal=taxId returns the tax identifier in clear. */
export async function GET(req: Request) {
  const reveal = new URL(req.url).searchParams.get("reveal") === "taxId";
  const requests = listCompanyRequests().map((r) => ({ ...r, target: requestTarget(r) }));
  return NextResponse.json({ profile: toProfileView(getProfile(), reveal), requests, activity: listCompanyActivity(60) });
}

/** Owner-only edit. Any waiting information request whose field is now filled resolves and resumes its agent. */
export async function PATCH(req: Request) {
  try {
    const b = await readJson<Record<string, unknown>>(req);
    const profile = updateProfile({
      name: typeof b.name === "string" ? b.name : undefined,
      legalName: typeof b.legalName === "string" ? b.legalName : undefined,
      entityType: typeof b.entityType === "string" ? b.entityType : undefined,
      industry: typeof b.industry === "string" ? b.industry : undefined,
      website: typeof b.website === "string" ? b.website : undefined,
      description: typeof b.description === "string" ? b.description : undefined,
      timezone: typeof b.timezone === "string" ? b.timezone : undefined,
      ownerFirstName: typeof b.ownerFirstName === "string" ? b.ownerFirstName : undefined,
      ownerLastName: typeof b.ownerLastName === "string" ? b.ownerLastName : undefined,
      ownerTitle: typeof b.ownerTitle === "string" ? b.ownerTitle : undefined,
      address: b.address,
      billingSameAsCompany: typeof b.billingSameAsCompany === "boolean" ? b.billingSameAsCompany : undefined,
      billingAddress: b.billingAddress,
      legal: b.legal && typeof b.legal === "object" ? (b.legal as Record<string, string>) : undefined,
    });
    const resolved = await resolveFilledRequests();
    return NextResponse.json({ profile: toProfileView(profile), resolved });
  } catch (err) {
    return jsonError(err);
  }
}
