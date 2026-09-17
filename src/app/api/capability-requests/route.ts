export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listRequests } from "@/lib/capabilities/store";
import { submitCapabilityRequest } from "@/lib/capabilities/manager";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import "@/lib/tools/servers";

export async function GET() {
  return NextResponse.json({ requests: listRequests() });
}

/** Owner/test entry point: file a capability request on behalf of an agent (agents normally call request_capability themselves). */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ agentId?: string; capability?: string; reason?: string; context?: string }>(req);
    const agentId = str(body.agentId, 100)?.trim();
    const capability = str(body.capability, 200)?.trim();
    if (!agentId || !capability) throw new RuntimeError("agentId and capability are required");
    const r = submitCapabilityRequest(agentId, { capability, reason: str(body.reason, 2_000) ?? "", context: str(body.context, 6_000) ?? "" });
    if (!r) throw new RuntimeError("Agent not found");
    return NextResponse.json({ request: r }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
