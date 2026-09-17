export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSettings, listMethods, updateSettings } from "@/lib/payments/store";
import { jsonError, readJson } from "@/lib/api-helpers";

export async function GET() {
  return NextResponse.json({ settings: getSettings(), methods: listMethods() });
}

/** Owner only (the proxy authenticates the owner session): automatic spending limit + default method. */
export async function PUT(req: Request) {
  try {
    const body = await readJson<{ autoApproveLimit?: number; defaultPaymentMethodId?: string | null }>(req);
    return NextResponse.json({ settings: updateSettings(body) });
  } catch (err) {
    return jsonError(err);
  }
}
