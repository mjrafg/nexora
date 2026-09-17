export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { handleBrowserTool, BROWSER_TOOL_NAMES } from "@/lib/browser";
import { reportToMeta } from "@/lib/browser";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";

/**
 * Browser Test Lab: run one browser tool against a lab session (key lab:<name>).
 * Diagnostic only — the same host the agents use, so what passes here passes for them.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ session?: string; tool?: string; args?: Record<string, unknown> }>(req);
    const name = str(body.session, 60)?.trim().replace(/[^\w-]/g, "_") || "default";
    const tool = str(body.tool, 60)?.trim() ?? "";
    if (!BROWSER_TOOL_NAMES.includes(tool) && tool !== "_test_crash") throw new RuntimeError(`Unknown browser tool ${tool}`);
    const key = `lab:${name}`;
    const t0 = Date.now();
    const r = await handleBrowserTool({ key, ownerAgentId: "lab", label: `Test Lab · ${name}` }, tool, body.args ?? {});
    const text = r.content ? r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n") : r.text ?? "";
    return NextResponse.json({ ok: !r.isError, text, report: reportToMeta(r.report, key), durationMs: Date.now() - t0, session: key });
  } catch (err) {
    return jsonError(err);
  }
}
