export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { customDataNamespaces, listCustomData, SecretRejected, upsertCustomDatum } from "@/lib/company/custom-data";
import { resolveFilledRequests } from "@/lib/company/service";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import "@/lib/tools/servers";

export async function GET() {
  return NextResponse.json({ data: listCustomData(), namespaces: customDataNamespaces() });
}

/** Owner adds or replaces an entry. Owner writes are verified unless marked provisional. */
export async function POST(req: Request) {
  try {
    const b = await readJson<Record<string, unknown>>(req);
    const datum = upsertCustomDatum(
      {
        key: str(b.key, 120) ?? "",
        value: b.value,
        valueType: str(b.valueType, 20) as never,
        label: str(b.label, 120),
        description: str(b.description, 600),
        status: b.status === "provisional" ? "provisional" : "verified",
      },
      { kind: "owner" },
    );
    // an agent may be waiting for exactly this key
    const resolved = await resolveFilledRequests();
    return NextResponse.json({ datum, resolved }, { status: 201 });
  } catch (err) {
    return jsonError(err, err instanceof SecretRejected ? 422 : 400);
  }
}
