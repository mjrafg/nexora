export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listCapabilities } from "@/lib/capabilities/registry";
import { managerOverview } from "@/lib/capabilities/manager";
import { listCapabilityActivity, listRequests } from "@/lib/capabilities/store";
import "@/lib/tools/servers";

/** Company capability registry + Capability Manager overview, requests and recent activity. */
export async function GET() {
  return NextResponse.json({
    capabilities: listCapabilities(),
    overview: managerOverview(),
    requests: listRequests(),
    activity: listCapabilityActivity(200),
  });
}
