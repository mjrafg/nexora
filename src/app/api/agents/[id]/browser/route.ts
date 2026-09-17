export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { handleBrowserTool, liveBrowserKeys } from "@/lib/browser/host";
import { agentBrowserKey, browserScopeFor } from "@/lib/browser";
import { closeHandoff, listHandoffs, openHandoff, ownerHasControl } from "@/lib/browser/handoff";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import { readDb } from "@/lib/store/db";
import "@/lib/tools/servers";

type Ctx = { params: Promise<{ id: string }> };

const OWNER_INPUT: Record<string, string> = { click: "owner_click", type: "owner_type", key: "owner_key", scroll: "owner_scroll", navigate: "browser_navigate" };

function agentOr404(id: string) {
  const agent = readDb().agents.find((a) => a.id === id);
  if (!agent) throw new RuntimeError("Agent not found");
  return agent;
}

/**
 * The Browser Dock's frame of the agent's own session.
 *
 * Never starts a browser: if the agent has no live session the dock says so
 * rather than launching one behind the agent's back.
 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const agent = agentOr404(id);
    const key = agentBrowserKey(agent.id);
    const handoff = openHandoff(agent.id);
    const control = ownerHasControl(agent.id) ? "owner" : "agent";
    if (!liveBrowserKeys().includes(key)) {
      return NextResponse.json({ live: false, control, handoff, recent: listHandoffs(agent.id).slice(0, 5), session: key });
    }
    const r = await handleBrowserTool(browserScopeFor(agent.id), "owner_view", {});
    if (r.isError) return NextResponse.json({ live: true, control, handoff, session: key, error: r.text });
    const view = JSON.parse(r.text ?? "{}") as Record<string, unknown>;
    return NextResponse.json({ live: true, control, handoff, session: key, ...view });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * Owner actions on the dock: drive the page while they hold control, or end
 * the handoff. Input is refused unless an INTERACTIVE handoff is open, so the
 * owner and the agent can never fight over the same page.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const agent = agentOr404(id);
    const body = await readJson<Record<string, unknown>>(req);
    const action = str(body.action, 30) ?? "";

    if (action === "return" || action === "cancel") {
      const open = openHandoff(agent.id);
      if (!open) throw new RuntimeError("Nothing to return — this agent has not handed you its browser");
      const handoff = await closeHandoff(open.id, action === "return" ? "RETURNED" : "CANCELLED", str(body.note, 500));
      return NextResponse.json({ ok: true, handoff });
    }

    const tool = OWNER_INPUT[action];
    if (!tool) throw new RuntimeError(`Unknown action ${action}`);
    const control = ownerHasControl(agent.id);
    if (!control) throw new RuntimeError(`${agent.name} is controlling this browser. Ask it to hand over control before you type in the page.`);
    const args: Record<string, unknown> =
      action === "click" ? { x: Number(body.x), y: Number(body.y), double: !!body.double }
      : action === "type" ? { text: str(body.text, 2_000) ?? "" }
      : action === "key" ? { key: str(body.key, 40) ?? "" }
      : action === "scroll" ? { dx: Number(body.dx) || 0, dy: Number(body.dy) || 0 }
      : { url: str(body.url, 2_000) ?? "" };
    const r = await handleBrowserTool(browserScopeFor(agent.id), tool, args);
    if (r.isError) throw new RuntimeError(r.text ?? "browser action failed");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
