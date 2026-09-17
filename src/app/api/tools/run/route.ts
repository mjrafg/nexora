export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { readDb } from "@/lib/store/db";
import { turnEmitter } from "@/lib/activity";
import { runTool } from "@/lib/tools/runner";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import "@/lib/tools/servers";

/**
 * Owner/diagnostic: run one tool AS an agent through the Nexora Tool Runner
 * (grants + side-effect guard + activity), optionally in a named execution
 * scope. This is the exact path agent turns use, so it doubles as the
 * regression harness for duplicate prevention.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ agentId?: string; tool?: string; args?: Record<string, unknown>; scopeId?: string; chatId?: string }>(req);
    const agentId = str(body.agentId, 100)?.trim();
    const tool = str(body.tool, 200)?.trim();
    if (!agentId || !tool) throw new RuntimeError("agentId and tool are required");
    const agent = readDb().agents.find((a) => a.id === agentId);
    if (!agent) throw new RuntimeError("Agent not found");
    const turnId = randomUUID();
    const scopeId = str(body.scopeId, 200)?.trim() || `owner-run:${turnId.slice(0, 8)}`;
    const chatId = str(body.chatId, 80)?.trim() || undefined;
    const rec = await runTool(agent, { agentId, turnId, emit: turnEmitter(agentId, turnId), scopeId, chatId }, tool, body.args ?? {});
    const { images, ...rest } = rec;
    return NextResponse.json({ ...rest, imageCount: images?.length ?? 0, scopeId });
  } catch (err) {
    return jsonError(err);
  }
}
