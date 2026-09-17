/* ------------------------------------------------------------------
   Chat log export.

   The full record of a thread — every message, every step an agent took,
   every tool call with its input and output, guard verdicts, usage,
   compactions and assumptions — rendered as Markdown, JSON or a
   self-contained HTML page. Nothing is collapsed away.

   Secrets never appear: tool arguments were masked by the side-effect guard
   before they were ever stored, results marked sensitive were replaced at
   persistence time, and this module only reads what is already on disk.
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import type { ActivityEvent } from "@/lib/activity";
import type { AgentAssumption } from "@/lib/agents/types";
import type { ChatMessage, ToolCallRecordLike } from "./log-types";
import { computeChatUsage } from "./context";
import { chatMessages, getChat } from "./store";
import type { ChatCompaction, ChatContextUsage, ChatThread } from "./types";

export type ExportFormat = "markdown" | "json" | "html";

export type ChatExportBundle = {
  exportedAt: string;
  app: { name: string; version: string };
  agent: { id: string; name: string; role: string; dept: string; runtime: string; model: string; provider: string };
  chat: ChatThread;
  usage: ChatContextUsage | null;
  compactions: ChatCompaction[];
  assumptions: AgentAssumption[];
  messages: ChatMessage[];
};

export function buildExportBundle(chatId: string): ChatExportBundle | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const db = readDb();
  const agent = db.agents.find((a) => a.id === chat.agentId);
  const config = agent && db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  const conn = config && db.providerConnections.find((c) => c.id === config.providerConnectionId);
  const messages = chatMessages(chatId);
  const scopes = new Set(db.conversations.filter((c) => c.chatId === chatId).map((c) => c.executionScopeId));
  return {
    exportedAt: new Date().toISOString(),
    app: { name: "Nexora OS", version: process.env.npm_package_version ?? "0.1.0" },
    agent: {
      id: chat.agentId,
      name: agent?.name ?? chat.agentId,
      role: agent?.role ?? "",
      dept: agent?.dept ?? "",
      runtime: config?.runtimeType ?? "",
      model: config?.model ?? "",
      provider: conn?.name ?? "",
    },
    chat,
    usage: computeChatUsage(chatId),
    compactions: db.chatCompactions.filter((c) => c.chatId === chatId).sort((a, b) => a.at.localeCompare(b.at)),
    assumptions: db.agentAssumptions.filter((a) => a.agentId === chat.agentId && (!a.scopeId || scopes.has(a.scopeId))),
    messages,
  };
}

/* ---------------------------------------------------------------- helpers */

const time = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const dur = (ms?: number) => (ms == null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const tok = (n?: number | null) =>
  n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export function fileName(b: ChatExportBundle, format: ExportFormat): string {
  const slug = `${b.agent.name}-${b.chat.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "chat";
  const ext = format === "markdown" ? "md" : format === "json" ? "json" : "html";
  return `${slug}-${b.exportedAt.slice(0, 10)}.${ext}`;
}

export function contentType(format: ExportFormat): string {
  return format === "markdown" ? "text/markdown; charset=utf-8" : format === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
}

function usageLine(u: ChatContextUsage | null): string {
  if (!u) return "unknown";
  const used = `${u.source === "provider" ? "" : "~"}${tok(u.usedTokens)}${u.pendingTokens > 0 ? ` + ~${tok(u.pendingTokens)} since the last report` : ""}`;
  const win = u.windowTokens ? `${tok(u.windowTokens)} window` : "window unknown";
  const pct = u.pct != null ? ` (${u.pct}%)` : "";
  const src = u.source === "provider" ? "provider-reported" : u.source === "estimated" ? "Nexora estimate" : "no data";
  return `${used} / ${win}${pct} — ${src}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Messages and compactions in the order they actually happened. */
type Entry = { kind: "message"; t: string; m: ChatMessage } | { kind: "compaction"; t: string; c: ChatCompaction };

function timeline(b: ChatExportBundle): Entry[] {
  return [
    ...b.messages.map((m) => ({ kind: "message" as const, t: m.createdAt, m })),
    ...b.compactions.map((c) => ({ kind: "compaction" as const, t: c.at, c })),
  ].sort((x, y) => x.t.localeCompare(y.t));
}

/* ---------------------------------------------------------------- markdown */

export function toMarkdown(b: ChatExportBundle): string {
  const out: string[] = [];
  out.push(`# ${b.chat.title}`, "");
  out.push(`- **Agent:** ${b.agent.name}${b.agent.role ? ` · ${b.agent.role}` : ""}`);
  out.push(`- **Runtime:** ${b.agent.runtime} · ${b.agent.provider} · ${b.agent.model}`);
  out.push(`- **Started:** ${time(b.chat.createdAt)} · **Last activity:** ${time(b.chat.updatedAt)}`);
  out.push(`- **Messages:** ${b.messages.length} · **Context at export:** ${usageLine(b.usage)}`);
  out.push(`- **Exported:** ${time(b.exportedAt)} by ${b.app.name} v${b.app.version}`);
  out.push("");

  for (const entry of timeline(b)) {
    if (entry.kind === "compaction") {
      const c = entry.c;
      out.push(`> **Context compacted** · ${c.runtimeType} · ${tok(c.beforeTokens)} → ${tok(c.afterTokens)} tokens · ${c.source}-measured · ${c.reason} · ${time(c.at)}`, "");
      continue;
    }
    const m = entry.m;
    out.push("---", "");
    if (m.role === "user") {
      out.push(`### ${m.origin === "system" ? "⚙︎ Nexora" : "🧑 Owner"} · ${time(m.createdAt)}`, "", m.content, "");
      continue;
    }
    out.push(`### 🤖 ${b.agent.name} · ${time(m.createdAt)}${m.stopped ? " · stopped by the owner" : ""}${m.error ? " · failed" : ""}`, "");
    const meta: string[] = [];
    if (m.runtime) meta.push(`${m.runtime.runtimeType} · ${m.runtime.model}`);
    if (m.usage?.inputTokens != null) meta.push(`${m.usage.inputTokens.toLocaleString()} in / ${(m.usage.outputTokens ?? 0).toLocaleString()} out tokens`);
    if (m.usage?.contextTokens != null) meta.push(`context ${tok(m.usage.contextTokens)}${m.usage.contextWindow ? ` / ${tok(m.usage.contextWindow)}` : ""}`);
    if (m.usage?.costUsd != null) meta.push(`$${m.usage.costUsd.toFixed(4)}`);
    if (m.usage?.durationMs != null) meta.push(dur(m.usage.durationMs));
    if (meta.length) out.push(`> ${meta.join(" · ")}`, "");

    for (const e of m.activity ?? []) out.push(...activityToMarkdown(e));
    for (const tc of m.toolCalls ?? []) out.push(...toolCallToMarkdown(tc));
    if (m.activity?.length || m.toolCalls?.length) out.push("");
    out.push(m.content, "");
  }

  if (b.assumptions.length) {
    out.push("---", "", `## Assumptions ${b.agent.name} made`, "");
    for (const a of b.assumptions) out.push(`- **${a.summary}**${a.detail ? ` — ${a.detail}` : ""}${a.customDataKey ? ` (\`${a.customDataKey}\`)` : ""}`);
    out.push("");
  }
  return out.join("\n");
}

function activityToMarkdown(e: ActivityEvent): string[] {
  // what the agent said reads as prose; what it did stays folded
  if (e.kind === "note") return ["", e.title, ""];
  const head = `**${labelOf(e)}**${e.meta ? ` · ${e.meta}` : ""}${e.status ? ` · ${e.status}` : ""}${e.durationMs ? ` · ${dur(e.durationMs)}` : ""}`;
  const lines = [`<details><summary>${escapeHtml(head)} — ${escapeHtml(e.title)}</summary>`, ""];
  lines.push(`- Time: ${time(new Date(e.ts).toISOString())}`);
  if (e.browser?.url) lines.push(`- URL: ${e.browser.url}`);
  if (e.browser?.action) lines.push(`- Browser action: ${e.browser.action}${e.browser.ref ? ` (${e.browser.ref})` : ""}`);
  if (e.guard) lines.push(`- Guard: ${e.guard.outcome}${e.guard.class ? ` · ${e.guard.class}` : ""}`);
  if (e.detail) lines.push("", "Input:", "", "```", e.detail, "```");
  if (e.output) lines.push("", "Output:", "", "```", e.output, "```");
  lines.push("", "</details>", "");
  return lines;
}

function labelOf(e: ActivityEvent): string {
  return { model: "Model call", tool: "Tool", command: "Command", file: "File", browser: "Browser", result: "Result", reasoning: "Reasoning", status: "Status", note: "Said" }[e.kind] ?? e.kind;
}

function toolCallToMarkdown(tc: ToolCallRecordLike): string[] {
  const lines = [`<details><summary>Tool · ${escapeHtml(tc.server)} → ${escapeHtml(tc.tool)} · ${tc.ok ? "ok" : "failed"} · ${dur(tc.durationMs)}</summary>`, ""];
  if (tc.guard) lines.push(`- Guard: ${tc.guard.outcome}`);
  lines.push("", "Input:", "", "```json", JSON.stringify(tc.args, null, 2), "```");
  lines.push("", tc.ok ? "Result:" : "Error:", "", "```", (tc.ok ? tc.result : tc.error) || "(none)", "```");
  lines.push("", "</details>", "");
  return lines;
}

/* ---------------------------------------------------------------- json */

export function toJson(b: ChatExportBundle): string {
  return JSON.stringify(b, null, 2);
}

/* ---------------------------------------------------------------- html */

export function toHtml(b: ChatExportBundle): string {
  const rows = timeline(b)
    .map((entry) => {
      if (entry.kind === "compaction") {
        const c = entry.c;
        return `<div class="compaction">Context compacted · ${escapeHtml(c.runtimeType)} · ${tok(c.beforeTokens)} → ${tok(c.afterTokens)} tokens · ${escapeHtml(c.source)}-measured · ${escapeHtml(c.reason)} · ${time(c.at)}</div>`;
      }
      const m = entry.m;
      const who = m.role === "user" ? (m.origin === "system" ? "Nexora" : "Owner") : b.agent.name;
      const cls = m.role === "user" ? (m.origin === "system" ? "sys" : "owner") : m.error ? "err" : "agent";
      const steps = [
        ...(m.activity ?? []).map(
          (e) => `<details class="step"><summary><b>${escapeHtml(labelOf(e))}</b> ${escapeHtml(e.title)}${e.meta ? ` <i>${escapeHtml(e.meta)}</i>` : ""}${
            e.status ? ` <span class="tag">${e.status}</span>` : ""
          }${e.durationMs ? ` <span class="dim">${dur(e.durationMs)}</span>` : ""}</summary>${
            e.browser?.url ? `<div class="dim">${escapeHtml(e.browser.url)}</div>` : ""
          }${e.detail ? `<pre>${escapeHtml(e.detail)}</pre>` : ""}${e.output ? `<pre>${escapeHtml(e.output)}</pre>` : ""}</details>`
        ),
        ...(m.toolCalls ?? []).map(
          (tc) => `<details class="step"><summary><b>Tool</b> ${escapeHtml(tc.server)} → ${escapeHtml(tc.tool)} <span class="tag">${tc.ok ? "ok" : "failed"}</span></summary><pre>${escapeHtml(
            JSON.stringify(tc.args, null, 2)
          )}</pre><pre>${escapeHtml((tc.ok ? tc.result : tc.error) || "")}</pre></details>`
        ),
      ].join("");
      return `<article class="msg ${cls}"><header>${escapeHtml(who)} <span class="dim">${time(m.createdAt)}</span>${
        m.stopped ? ' <span class="tag">stopped by the owner</span>' : ""
      }</header>${steps}<div class="body">${escapeHtml(m.content).replace(/\n/g, "<br>")}</div></article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(b.chat.title)} — ${escapeHtml(b.agent.name)}</title>
<style>
:root{color-scheme:dark;--bg:#0b0d13;--card:#141824;--line:#232838;--ink:#e8ecf7;--dim:#8b93ab;--brand:#6d7cff}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto}
h1{font-size:20px;margin:0 0 6px}
.meta{color:var(--dim);font-size:12.5px;margin-bottom:22px}
.msg{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 12px}
.msg.owner{border-color:#3a44a8;background:#171a2e}
.msg.sys{border-style:dashed}
.msg.err{border-color:#7a2b3c}
.msg header{font-weight:600;margin-bottom:8px}
.dim{color:var(--dim);font-weight:400}
.compaction{text-align:center;color:var(--dim);font-size:12px;border-top:1px dashed var(--line);border-bottom:1px dashed var(--line);padding:6px;margin:0 0 12px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:0 6px;font-size:11px;color:var(--dim)}
.step{border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin:0 0 6px;font-size:12.5px}
.step summary{cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;background:#0a0c12;border:1px solid var(--line);border-radius:6px;padding:8px;font-size:11.5px;overflow-x:auto}
.body{white-space:normal}
footer{color:var(--dim);font-size:12px;margin-top:24px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><main>
<h1>${escapeHtml(b.chat.title)}</h1>
<div class="meta">
${escapeHtml(b.agent.name)}${b.agent.role ? ` · ${escapeHtml(b.agent.role)}` : ""} · ${escapeHtml(b.agent.runtime)} · ${escapeHtml(b.agent.model)}<br>
${b.messages.length} messages · context at export: ${escapeHtml(usageLine(b.usage))}<br>
Exported ${time(b.exportedAt)} by ${escapeHtml(b.app.name)} v${escapeHtml(b.app.version)}
</div>
${rows}
${
  b.assumptions.length
    ? `<h2>Assumptions ${escapeHtml(b.agent.name)} made</h2><ul>${b.assumptions
        .map((a) => `<li><b>${escapeHtml(a.summary)}</b>${a.detail ? ` — ${escapeHtml(a.detail)}` : ""}${a.customDataKey ? ` <code>${escapeHtml(a.customDataKey)}</code>` : ""}</li>`)
        .join("")}</ul>`
    : ""
}
<footer>Complete log: every message, step, tool call and result recorded for this chat. Secrets are never recorded.</footer>
</main></body></html>`;
}

export function renderExport(b: ChatExportBundle, format: ExportFormat): string {
  return format === "json" ? toJson(b) : format === "html" ? toHtml(b) : toMarkdown(b);
}
