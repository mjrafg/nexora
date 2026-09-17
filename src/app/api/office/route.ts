export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { officeFloor } from "@/lib/office/floor";

/** The company as it stands right now: real departments, real agents, real state. */
export async function GET() {
  return NextResponse.json(officeFloor());
}
