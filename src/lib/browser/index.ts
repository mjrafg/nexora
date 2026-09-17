/* ------------------------------------------------------------------
   Web Browser as a normal Nexora capability.

     Agent → tool permission "browser" → this tool server → browser host

   Access is an agent-level permission, so it survives any runtime/provider
   change. Every action is recorded on the agent's activity channel with the
   same sanitized facts Tandem records (never cookies, storage or secrets).
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import { activePaymentSecretStrings, redactPaymentSecrets } from "@/lib/payments/store";
import type { BrowserActionMeta } from "@/lib/activity";
import { registerToolServer, type InternalToolResult, type InternalToolServer, type ToolCallContext } from "@/lib/tools/internal";
import { handleBrowserTool, safeKey, type BrowserReport, type BrowserScope, type BrowserToolResult } from "./host";
import { BROWSER_TOOLS } from "./tools";

export * from "./host";
export * from "./tools";

/** The agent's own persistent browser session key. */
export function agentBrowserKey(agentId: string): string {
  return `agent:${agentId}`;
}

export function browserScopeFor(agentId: string, keyOverride?: string): BrowserScope {
  const agent = readDb().agents.find((a) => a.id === agentId);
  const key = keyOverride ?? agentBrowserKey(agentId);
  return { key, ownerAgentId: agentId, label: keyOverride ? keyOverride : agent ? `${agent.name}'s browser` : key };
}

export function reportToMeta(report: BrowserReport | null | undefined, key: string): BrowserActionMeta | undefined {
  if (!report) return undefined;
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  return {
    action: s(report.action, 40) ?? "action",
    url: s(report.url, 600),
    title: s(report.title, 200),
    viewport: report.viewport && typeof report.viewport.width === "number" ? report.viewport : undefined,
    ref: s(report.ref, 120),
    value: s(report.value, 240),
    screenshotUrl: s(report.screenshotUrl, 200),
    console: Array.isArray(report.console) ? report.console.slice(0, 12).map((c) => ({ level: s(c.level, 20) ?? "log", text: s(c.text, 240) ?? "" })) : undefined,
    error: s(report.error, 400),
    session: safeKey(key),
  };
}

function resultText(r: BrowserToolResult): string {
  if (r.content) return r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
  return r.text ?? "ok";
}

/** Run one browser tool for an agent turn and record it in the activity stream. */
export async function runBrowserTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<InternalToolResult> {
  if (name === "present_browser") return presentBrowser(args, ctx);
  const scope = browserScopeFor(ctx.agentId, ctx.browserKey);
  const summary = summarizeArgs(name, args);
  const evId = ctx.emit.event({ kind: "browser", title: `${name.replace("browser_", "")}${summary ? ` ${summary}` : ""}`, meta: "Browser", detail: summary, status: "running", browser: { action: name.replace("browser_", ""), session: safeKey(scope.key) } });
  const r = await handleBrowserTool(scope, name, args);
  // a checkout can leak payment fields into URLs/titles/page text (e.g. a GET form); scrub every active payment secret
  // before anything is recorded or returned — screenshots are the one thing that cannot be scrubbed
  const text = redactPaymentSecrets(resultText(r));
  const meta = reportToMeta(r.report ? { ...r.report, url: r.report.url && redactPaymentSecrets(r.report.url), title: r.report.title && redactPaymentSecrets(r.report.title), detail: redactPaymentSecrets(r.report.detail), value: r.report.value && redactPaymentSecrets(r.report.value) } : r.report, scope.key);
  ctx.emit.event({
    id: evId,
    kind: "browser",
    title: r.report?.detail ? redactPaymentSecrets(r.report.detail).slice(0, 160) : name,
    meta: "Browser",
    output: text.slice(0, 2000),
    status: r.isError ? "failed" : "done",
    browser: meta,
  });
  const images = (r.content ?? []).filter((c): c is { type: "image"; data: string; mimeType: string } => c.type === "image").map((c) => ({ mimeType: c.mimeType, data: c.data }));
  return { ok: !r.isError, text, images: images.length ? images : undefined, browser: meta };
}

/**
 * Hand the owner a view of — or the controls of — the agent's own browser.
 * No new browser, no new context: the dock renders the very session this
 * agent is driving.
 */
async function presentBrowser(args: Record<string, unknown>, ctx: ToolCallContext): Promise<InternalToolResult> {
  const reason = String(args.reason ?? "").trim();
  if (!reason) return { ok: false, text: "reason is required: tell the owner exactly what to look at or do." };
  const mode = String(args.mode ?? "view").toLowerCase() === "interactive" ? "INTERACTIVE" : "VIEW";
  try {
    const { createHandoff } = await import("./handoff");
    const h = createHandoff({ agentId: ctx.agentId, mode, reason, executionScopeId: ctx.scopeId });
    ctx.emit.event({
      kind: "browser", meta: "Browser", status: "done",
      title: mode === "INTERACTIVE" ? `Handed the browser to the owner: ${reason.slice(0, 120)}` : `Showed the browser to the owner: ${reason.slice(0, 120)}`,
      browser: { action: "present", session: safeKey(agentBrowserKey(ctx.agentId)) },
    });
    return {
      ok: true,
      text: mode === "INTERACTIVE"
        ? `The owner now has control of your browser (handoff ${h.id.slice(0, 8)}). Do not use any browser tool until control comes back. END YOUR TURN now — you are resumed automatically when they return it, and your first step then is browser_snapshot to see the page as they left it.`
        : `The Browser Dock is open on the owner's Agent page showing your current page (handoff ${h.id.slice(0, 8)}). You keep control — carry on. Call present_browser with mode "interactive" if you need them to act in the page.`,
    };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  switch (name) {
    case "browser_navigate": return String(a.url ?? "");
    case "browser_search": return `"${String(a.query ?? "").slice(0, 80)}"`;
    case "browser_click": return String(a.element ?? a.ref ?? a.selector ?? "");
    case "browser_type": {
      const t = a.text === undefined ? undefined : String(a.text);
      const secret = !!a.sensitive || !!a.credential || (t !== undefined && activePaymentSecretStrings().some((v) => t.replace(/[\s-]/g, "") === v || t === v));
      return `${String(a.element ?? a.ref ?? a.selector ?? "")}${secret ? " (redacted)" : t !== undefined ? ` ← ${JSON.stringify(t.slice(0, 60))}` : ""}`;
    }
    case "browser_select": return `${String(a.ref ?? a.selector ?? "")} ← ${((a.values as string[]) ?? []).join(", ")}`;
    case "browser_press": return String(a.key ?? "");
    case "browser_wait": return a.text ? `for "${a.text}"` : a.textGone ? `until "${a.textGone}" gone` : a.selector ? `for ${a.selector}` : a.urlContains ? `for url "${a.urlContains}"` : `${a.seconds ?? 1}s`;
    case "browser_resize": return `${a.width}×${a.height}`;
    case "browser_tabs": return String(a.action ?? "list");
    case "browser_evaluate": return String(a.code ?? "").slice(0, 80);
    case "browser_upload": return ((a.paths as string[]) ?? []).join(", ");
    case "present_browser": return `${String(a.mode ?? "view")} — ${String(a.reason ?? "").slice(0, 80)}`;
    default: return "";
  }
}

export const browserToolServer: InternalToolServer = registerToolServer({
  slug: "browser",
  name: "Nexora Browser",
  tools: BROWSER_TOOLS,
  selfRecords: true,
  call: runBrowserTool,
});

/** Does this agent hold the Web Browser capability? (agent-level, runtime-independent) */
export function agentHasBrowser(agent: { toolPermissions: string[] }): boolean {
  return agent.toolPermissions.includes("browser");
}
