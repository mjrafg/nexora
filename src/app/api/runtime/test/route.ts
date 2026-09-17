import { NextResponse } from "next/server";
import { testRuntimeConfig } from "@/lib/runtime";
import { jsonError, readJson } from "@/lib/api-helpers";
import { cleanAdvanced, type RuntimeInput } from "@/lib/runtime/input";
import { RuntimeError } from "@/lib/runtime/types";

export async function POST(req: Request) {
  try {
    const body = await readJson<RuntimeInput>(req);
    if (!body.runtimeType || !body.providerConnectionId || !body.model) {
      throw new RuntimeError("runtimeType, providerConnectionId and model are required");
    }
    const result = await testRuntimeConfig({
      runtimeType: body.runtimeType,
      providerConnectionId: body.providerConnectionId,
      model: body.model,
      advancedSettings: cleanAdvanced(body.advancedSettings),
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err);
  }
}
