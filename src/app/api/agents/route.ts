export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { DEFAULT_RUNTIME } from "@/lib/runtime/catalog";
import { toAgentView, validateCombination } from "@/lib/runtime";
import { reconcileAgentWaiting } from "@/lib/agents/waiting";
import type { AgentRecord, RuntimeConfig } from "@/lib/runtime/types";
import { normalizeGrants } from "@/lib/mcp/store";
import { cleanAdvanced, type RuntimeInput } from "@/lib/runtime/input";
import { RuntimeError } from "@/lib/runtime/types";
import { departments, type DeptId } from "@/lib/mock-data";
import { jsonError, readJson, str, strList } from "@/lib/api-helpers";

export async function GET() {
  // the agent list is the other place a ghost wait would show up — repair first
  reconcileAgentWaiting();
  return NextResponse.json({ agents: readDb().agents.map(toAgentView) });
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{
      name?: string;
      role?: string;
      dept?: string;
      instructions?: string;
      skills?: string[];
      toolPermissions?: string[];
      mcpGrants?: unknown;
      runtime?: RuntimeInput;
    }>(req);

    const name = str(body.name, 80)?.trim();
    const role = str(body.role, 120)?.trim();
    const dept = str(body.dept, 40) as DeptId | undefined;
    if (!name) throw new RuntimeError("Name is required");
    if (!role) throw new RuntimeError("Role is required");
    if (!dept || !(dept in departments) || dept === "conference") throw new RuntimeError("A valid department is required");

    const db = readDb();
    const rin = body.runtime ?? {};
    const runtimeType = rin.runtimeType ?? DEFAULT_RUNTIME.runtimeType;
    const connection = rin.providerConnectionId
      ? db.providerConnections.find((c) => c.id === rin.providerConnectionId)
      : db.providerConnections.find((c) => c.providerType === DEFAULT_RUNTIME.providerType);
    if (!connection) throw new RuntimeError("Provider connection not found");
    validateCombination(runtimeType, connection);
    const model = str(rin.model, 200)?.trim() || DEFAULT_RUNTIME.model;

    const ts = now();
    const rc: RuntimeConfig = {
      id: newId(),
      runtimeType,
      providerConnectionId: connection.id,
      model,
      advancedSettings: cleanAdvanced(rin.advancedSettings),
    };
    const agent: AgentRecord = {
      id: newId(),
      name,
      role,
      dept,
      instructions: str(body.instructions)?.trim() || "",
      skills: strList(body.skills) ?? [],
      toolPermissions: strList(body.toolPermissions) ?? [],
      runtimeConfigId: rc.id,
      mcpGrants: normalizeGrants(body.mcpGrants),
      status: "online",
      createdAt: ts,
      updatedAt: ts,
    };
    updateDb((d) => {
      d.runtimeConfigs.push(rc);
      d.agents.push(agent);
    });
    return NextResponse.json({ agent: toAgentView(agent) }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
