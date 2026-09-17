export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createLoginCredential, listCredentialActivity, listCredentialRequests, listLoginCredentials, toView } from "@/lib/credentials/store";
import { resolveCredentialRequest } from "@/lib/credentials/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import "@/lib/tools/servers";

export async function GET() {
  return NextResponse.json({ credentials: listLoginCredentials().map(toView), requests: listCredentialRequests(), activity: listCredentialActivity(60) });
}

/** Owner adds a credential (optionally resolving a credential request, which resumes the requesting agent). */
export async function POST(req: Request) {
  try {
    const b = await readJson<Record<string, unknown>>(req);
    const credential = createLoginCredential({
      name: str(b.name, 120) ?? "", service: str(b.service, 80) ?? "", site: str(b.site, 200) ?? "", loginUrl: str(b.loginUrl, 500) || undefined, description: str(b.description, 1_000) ?? "",
      username: str(b.username, 200) ?? "", password: typeof b.password === "string" ? b.password : "", type: (["username_password", "api_key", "token"].includes(String(b.type)) ? String(b.type) : "username_password") as "username_password", createdBy: "owner",
    });
    const requestId = str(b.requestId, 100);
    const request = requestId ? await resolveCredentialRequest(requestId, credential.id) : undefined;
    return NextResponse.json({ credential: toView(credential), request }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
