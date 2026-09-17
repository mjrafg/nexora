export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readDb, updateDb, now } from "@/lib/store/db";
import { toAgentView, validateCombination } from "@/lib/runtime";
import { releaseAgentRequests, resolveAgentWaiting } from "@/lib/agents/waiting";
import { releaseAgentTasks } from "@/lib/tasks/store";
import { RuntimeError } from "@/lib/runtime/types";
import { departments, type DeptId } from "@/lib/mock-data";
import { jsonError, readJson, str, strList } from "@/lib/api-helpers";
import { cleanAdvanced, type RuntimeInput } from "@/lib/runtime/input";
import { normalizeGrants } from "@/lib/mcp/store";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const agent = readDb().agents.find((a) => a.id === id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  // repair a waiting state whose backing request is gone before it reaches the header
  resolveAgentWaiting(agent, { repair: true });
  const fresh = readDb().agents.find((a) => a.id === id)!;
  return NextResponse.json({ agent: toAgentView(fresh) });
}

/**
 * Update identity and/or runtime. Changing the runtime edits the agent's existing
 * RuntimeConfig in place: agent id, department, instructions, skills, tools and
 * conversation history are untouched.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJson<{
      name?: string;
      role?: string;
      dept?: string;
      instructions?: string;
      skills?: string[];
      toolPermissions?: string[];
      status?: "online" | "busy" | "idle";
      mcpGrants?: unknown;
      managerAgentId?: string | null;
      runtime?: RuntimeInput;
    }>(req);

    const result = updateDb((d) => {
      const agent = d.agents.find((a) => a.id === id);
      if (!agent) throw new RuntimeError("Agent not found");

      const name = str(body.name, 80)?.trim();
      const role = str(body.role, 120)?.trim();
      const dept = str(body.dept, 40) as DeptId | undefined;
      if (name) agent.name = name;
      if (role) agent.role = role;
      if (dept) {
        if (!(dept in departments) || dept === "conference") throw new RuntimeError("Invalid department");
        agent.dept = dept;
      }
      if (body.instructions !== undefined) agent.instructions = str(body.instructions)?.trim() ?? "";
      const skills = strList(body.skills);
      if (skills) agent.skills = skills;
      const tools = strList(body.toolPermissions);
      if (tools) agent.toolPermissions = tools;
      if (body.status && ["online", "busy", "idle"].includes(body.status)) agent.status = body.status;
      if (body.mcpGrants !== undefined) agent.mcpGrants = normalizeGrants(body.mcpGrants);

      // who this agent reports to: nobody, or one real agent that is not itself
      // and not one of its own reports (a cycle would make the org meaningless)
      if (body.managerAgentId !== undefined) {
        const managerId = str(body.managerAgentId, 80)?.trim() || null;
        if (managerId) {
          if (managerId === agent.id) throw new RuntimeError("An agent cannot report to itself");
          if (!d.agents.some((a) => a.id === managerId)) throw new RuntimeError("That manager does not exist");
          for (let up = d.agents.find((a) => a.id === managerId), hops = 0; up && hops < 20; hops++) {
            if (up.managerAgentId === agent.id) throw new RuntimeError(`${up.name} already reports to ${agent.name} — that would be a loop`);
            up = d.agents.find((a) => a.id === up!.managerAgentId);
          }
        }
        agent.managerAgentId = managerId;
      }

      if (body.runtime) {
        const rc = d.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
        if (!rc) throw new RuntimeError("Runtime config missing");
        const runtimeType = body.runtime.runtimeType ?? rc.runtimeType;
        const connId = body.runtime.providerConnectionId ?? rc.providerConnectionId;
        const conn = d.providerConnections.find((c) => c.id === connId);
        if (!conn) throw new RuntimeError("Provider connection not found");
        validateCombination(runtimeType, conn);
        const model = str(body.runtime.model, 200)?.trim() || rc.model;
        if (!model) throw new RuntimeError("Model is required");
        rc.runtimeType = runtimeType;
        rc.providerConnectionId = conn.id;
        rc.model = model;
        if (body.runtime.advancedSettings !== undefined) rc.advancedSettings = cleanAdvanced(body.runtime.advancedSettings);
      }
      agent.updatedAt = now();
      return agent;
    });
    return NextResponse.json({ agent: toAgentView(result) });
  } catch (err) {
    return jsonError(err, err instanceof RuntimeError && err.message === "Agent not found" ? 404 : 400);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  // close what it was waiting for first: an open request whose requester is
  // gone can never be acted on, and would sit on the owner's lists forever
  releaseAgentRequests(id);
  releaseAgentTasks(id);
  const removed = updateDb((d) => {
    const agent = d.agents.find((a) => a.id === id);
    if (!agent) return false;
    d.agents = d.agents.filter((a) => a.id !== id);
    d.runtimeConfigs = d.runtimeConfigs.filter((r) => r.id !== agent.runtimeConfigId);
    d.messages = d.messages.filter((m) => m.agentId !== id);
    d.conversations = d.conversations.filter((c) => c.agentId !== id);
    d.chats = d.chats.filter((c) => c.agentId !== id);
    d.chatCompactions = d.chatCompactions.filter((c) => c.agentId !== id);
    return true;
  });
  if (!removed) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
