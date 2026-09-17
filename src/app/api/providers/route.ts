export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { PROVIDERS } from "@/lib/runtime/catalog";
import type { ProviderConnection, ProviderType } from "@/lib/runtime/types";
import { authFromInput, type AuthInput } from "@/lib/runtime/auth-input";
import { RuntimeError } from "@/lib/runtime/types";
import { toConnectionView } from "@/lib/providers-view";
import { jsonError, readJson, str } from "@/lib/api-helpers";

export async function GET() {
  return NextResponse.json({ connections: readDb().providerConnections.map(toConnectionView) });
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ name?: string; providerType?: ProviderType; baseUrl?: string; auth?: AuthInput }>(req);
    const name = str(body.name, 80)?.trim();
    const providerType = body.providerType;
    if (!name) throw new RuntimeError("Connection name is required");
    if (!providerType || !(providerType in PROVIDERS)) throw new RuntimeError("Valid provider type is required");
    const meta = PROVIDERS[providerType];
    const baseUrl = str(body.baseUrl, 500)?.trim() || meta.defaultBaseUrl;
    if (meta.requiresBaseUrl && !baseUrl) throw new RuntimeError("Base URL is required for a custom API");

    const ts = now();
    const conn: ProviderConnection = {
      id: newId(),
      name,
      providerType,
      auth: authFromInput(body.auth, providerType),
      baseUrl,
      status: "unknown",
      createdAt: ts,
      updatedAt: ts,
    };
    updateDb((d) => {
      d.providerConnections.push(conn);
    });
    return NextResponse.json({ connection: toConnectionView(conn) }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
