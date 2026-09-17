/* Claude Code runtime: executes agent turns through the `claude` CLI. */

import { randomUUID } from "node:crypto";
import { PROVIDERS } from "../catalog";
import { getSecret } from "@/lib/store/db";

const CLAUDE_TOKEN_SECRET_ID = "claude-code-oauth-token";
import type { AgentRuntime, ResolvedRuntime, RuntimeChatRequest, RuntimeChatResult } from "../types";
import { RuntimeError, TurnBudgetExhausted } from "../types";
import { agentWorkspace, childEnv, findBinary, renderTranscript, runCli, tail, type Env } from "./cli";
import { buildClaudeMcp } from "./mcp-cli";
import { recordModelWindow } from "@/lib/chats/context";

/** Map generic agent tool permissions onto Claude Code built-in tools. */
const TOOL_MAP: Record<string, string[]> = {
  web_search: ["WebSearch"],
  web_fetch: ["WebFetch"],
  read_files: ["Read", "Glob", "Grep"],
  write_files: ["Write", "Edit"],
  run_commands: ["Bash"],
};

function mapTools(permissions: string[]): string[] {
  return [...new Set(permissions.flatMap((p) => TOOL_MAP[p] ?? []))];
}

function locate(): string {
  const bin = findBinary("claude", [process.env.CLAUDE_CODE_BIN ?? ""]);
  if (!bin) throw new RuntimeError("Claude Code CLI not found", "Install Claude Code or set CLAUDE_CODE_BIN.");
  return bin;
}

function envFor(resolved: ResolvedRuntime): Env {
  const extra: Env = {};
  // Claude Code refuses --permission-mode bypassPermissions as root unless it is told it runs in a sandbox
  if (typeof process.getuid === "function" && process.getuid() === 0) extra.IS_SANDBOX = "1";
  if (resolved.secret) extra.ANTHROPIC_API_KEY = resolved.secret;
  else {
    // Long-lived token captured by the web login flow (Settings → AI Providers → Runtime logins).
    const token = getSecret(CLAUDE_TOKEN_SECRET_ID);
    if (token) extra.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  const base = resolved.connection.baseUrl;
  if (base && base !== PROVIDERS.anthropic.defaultBaseUrl) extra.ANTHROPIC_BASE_URL = base;
  return childEnv(extra);
}

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** per-step usage; the LAST entry describes the session's context size */
  iterations?: ClaudeUsage[];
};

type ClaudeJson = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: ClaudeUsage;
  /** provider-reported context window of the model that served the call */
  modelUsage?: Record<string, { contextWindow?: number }>;
};

/**
 * The size of the session context after the call, as Claude Code reports it.
 *
 * The top-level usage numbers are CUMULATIVE over every step of the turn — they
 * say what the turn consumed, not how full the session now is. The final
 * iteration is the one that describes the context, so that is what we read;
 * when the CLI reports no iterations we report nothing rather than passing a
 * cumulative figure off as a context size.
 */
function contextFromUsage(u: ClaudeUsage | undefined): number | undefined {
  const iters = (u?.iterations ?? []).filter((i) => i && (i.input_tokens != null || i.cache_read_input_tokens != null));
  const last = iters.at(-1);
  if (!last) return undefined;
  return (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.output_tokens ?? 0);
}

function windowFromModelUsage(mu: ClaudeJson["modelUsage"], model: string): number | undefined {
  if (!mu || typeof mu !== "object") return undefined;
  const entry = mu[model] ?? Object.values(mu)[0];
  const win = entry?.contextWindow;
  return typeof win === "number" && win > 0 ? win : undefined;
}

function kindOf(name: string): "tool" | "command" | "file" {
  if (name.startsWith("mcp__")) return "tool";
  if (name === "Bash") return "command";
  if (["Read", "Write", "Edit", "Glob", "Grep"].includes(name)) return "file";
  return "tool";
}

function summarizeInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  if (name === "Bash") return String(input.command ?? "").slice(0, 500);
  if (name === "Read" || name === "Write" || name === "Edit") return String(input.file_path ?? input.path ?? "").slice(0, 300);
  return JSON.stringify(input).slice(0, 500);
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as Record<string, unknown>).text ?? "") : "")).join("\n");
  return "";
}

function parseOutput(stdout: string): ClaudeJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeJson;
  } catch {
    // Sometimes the JSON is the last line after other output.
    const last = trimmed.split("\n").filter(Boolean).pop() ?? "";
    try {
      return JSON.parse(last) as ClaudeJson;
    } catch {
      return null;
    }
  }
}

async function invoke(
  req: Pick<RuntimeChatRequest, "systemPrompt" | "resolved"> & {
    prompt: string;
    tools: string[];
    cwd: string;
    session: { resume: string } | { start: string };
    mcpConfigPath?: string;
    mcpAllowed?: string[];
    silentToolPrefixes?: string[];
    emit?: import("@/lib/activity").TurnEmitter;
    toolLabel?: (name: string) => { title: string; meta?: string };
    onSpawn?: (kill: () => void) => void;
    timeoutMs?: number;
    toolProfile?: "builder" | "reader";
    turnBudget?: number;
  }
): Promise<RuntimeChatResult> {
  const bin = locate();
  const { config } = req.resolved;
  // agentic work needs far more turns than a chat reply; every tool call is a turn
  // one turn = one tool call; long browser work needs a real budget, and running
  // out of it is an owner decision (see owner-actions), not a failure
  const maxTurns = config.advancedSettings.maxTurns ?? req.turnBudget ?? (req.toolProfile === "builder" ? 300 : req.toolProfile === "reader" ? 80 : 25);
  const toolsArg = req.tools.length ? req.tools.join(",") : "";

  const args = [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", config.model,
    "--system-prompt", req.systemPrompt,
    "--tools", toolsArg,
    "--max-turns", String(maxTurns),
    "--permission-mode", req.tools.includes("Bash") ? "bypassPermissions" : "acceptEdits",
  ];
  const allowed = [...req.tools, ...(req.mcpAllowed ?? [])];
  if (allowed.length) args.push("--allowedTools", ...allowed);
  if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath, "--strict-mcp-config");
  if ("resume" in req.session) args.push("--resume", req.session.resume);
  else args.push("--session-id", req.session.start);
  args.push("--", req.prompt);

  const running = new Map<string, { name: string; label: { title: string; meta?: string } }>();
  let finalObj: ClaudeJson | null = null;
  const onLine = (line: string) => {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { return; }
    const type = ev.type as string;
    if (type === "assistant") {
      const content = ((ev.message as Record<string, unknown>)?.content ?? []) as Record<string, unknown>[];
      for (const b of content) {
        if (b.type === "tool_use") {
          const name = String(b.name ?? "");
          // self-recording Nexora servers (browser) log their own richer events
          if (req.silentToolPrefixes?.some((p) => name.startsWith(p))) continue;
          const label = req.toolLabel ? req.toolLabel(name) : { title: name };
          running.set(String(b.id), { name, label });
          req.emit?.event({ id: String(b.id), kind: kindOf(name), title: label.title, meta: label.meta, detail: summarizeInput(name, b.input as Record<string, unknown>), status: "running" });
        }
      }
    } else if (type === "user") {
      const content = ((ev.message as Record<string, unknown>)?.content ?? []) as Record<string, unknown>[];
      for (const b of content) {
        if (b.type === "tool_result") {
          const r = running.get(String(b.tool_use_id));
          if (r) {
            const outText = extractResultText(b.content);
            req.emit?.event({ id: String(b.tool_use_id), kind: kindOf(r.name), title: r.label.title, meta: r.label.meta, output: outText.slice(0, 2000), status: b.is_error ? "failed" : "done" });
            running.delete(String(b.tool_use_id));
          }
        }
      }
    } else if (type === "result") {
      finalObj = ev as ClaudeJson;
    }
  };
  const res = await runCli(bin, args, { cwd: req.cwd, env: envFor(req.resolved), timeoutMs: req.timeoutMs ?? 600_000, onLine, onSpawn: req.onSpawn });
  if (res.timedOut) throw new RuntimeError("Claude Code timed out", tail(res.stderr));
  const out = finalObj ?? parseOutput(res.stdout);
  if (res.code !== 0 && !out) {
    throw new RuntimeError("Claude Code exited with an error", tail(res.stderr || res.stdout));
  }
  if (!out) throw new RuntimeError("Claude Code returned no output", tail(res.stderr));
  if (out.is_error) {
    const reason = String(out.subtype ?? "");
    const ranOut = /max_turns/i.test(reason) || /max_turns/i.test(String(out.result ?? ""));
    if (ranOut) throw new TurnBudgetExhausted(maxTurns);
    const why = reason && reason !== "success" ? ` (${reason})` : "";
    throw new RuntimeError(out.result || `Claude Code reported an error${why}`, tail(res.stderr || res.stdout.slice(-800)));
  }

  const contextWindow = windowFromModelUsage(out.modelUsage, config.model);
  recordModelWindow("claude-code", config.model, contextWindow);
  return {
    text: out.result ?? "",
    sessionId: out.session_id,
    usage: {
      inputTokens: out.usage?.input_tokens,
      outputTokens: out.usage?.output_tokens,
      costUsd: out.total_cost_usd,
      durationMs: out.duration_ms,
      contextTokens: contextFromUsage(out.usage),
      contextWindow,
    },
  };
}

export const claudeCodeRuntime: AgentRuntime = {
  type: "claude-code",

  async chat(req) {
    const tools =
      req.toolProfile === "builder" ? ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch"]
      : req.toolProfile === "reader" ? ["Read", "Glob", "Grep"]
      : mapTools(req.agent.toolPermissions);
    const cwd = req.cwdOverride ?? agentWorkspace(req.agent.id, req.resolved.config.advancedSettings.workingDirectory);
    const mcp = await buildClaudeMcp(req.mcpTools, req.extraServers);
    const labelFor = (name: string): { title: string; meta?: string } => {
      const t = req.mcpTools.find((x) => `mcp__${x.serverSlug}__${x.toolName}` === name);
      if (t) return { title: t.toolName, meta: t.serverName };
      const x = req.extraServers?.find((srv) => name.startsWith(`mcp__${srv.slug}__`));
      if (x) return { title: name.slice(`mcp__${x.slug}__`.length), meta: x.name ?? (x.slug === "nexora" ? "Nexora" : x.slug.replace(/_/g, " ")) };
      return { title: name, meta: "Claude Code" };
    };
    const extra = { emit: req.emit, toolLabel: labelFor, onSpawn: req.onSpawn, timeoutMs: req.timeoutMs, toolProfile: req.toolProfile, turnBudget: req.turnBudget, silentToolPrefixes: req.silentToolPrefixes };
    try {
      if (req.sessionId) {
        try {
          return await invoke({ ...req, ...extra, prompt: req.message, tools, cwd, session: { resume: req.sessionId }, mcpConfigPath: mcp?.configPath, mcpAllowed: mcp?.allowed });
        } catch (err) {
          const detail = err instanceof RuntimeError ? `${err.message} ${err.detail ?? ""}` : String(err);
          if (!/session|conversation|resume/i.test(detail)) throw err;
        }
      }
      const prompt = req.freshPrompt ? req.message : renderTranscript(req.history, req.message);
      return await invoke({ ...req, ...extra, prompt, tools, cwd, session: { start: randomUUID() }, mcpConfigPath: mcp?.configPath, mcpAllowed: mcp?.allowed });
    } finally {
      mcp?.cleanup();
    }
  },

  async test(resolved) {
    const started = Date.now();
    let bin: string;
    try {
      bin = locate();
    } catch (err) {
      const e = err as RuntimeError;
      return { ok: false, message: e.message, detail: e.detail, durationMs: Date.now() - started };
    }
    const version = await runCli(bin, ["--version"], { env: envFor(resolved), timeoutMs: 20_000 });
    if (version.code !== 0) {
      return { ok: false, message: "Claude Code CLI failed to start", detail: tail(version.stderr), durationMs: Date.now() - started };
    }
    try {
      const cwd = agentWorkspace("_runtime-test");
      const r = await invoke({
        systemPrompt: "You are a connectivity probe. Reply with exactly: OK",
        resolved,
        prompt: "Reply with the single word OK.",
        tools: [],
        cwd,
        session: { start: randomUUID() },
      });
      return {
        ok: true,
        message: "Connected",
        detail: `Claude Code ${version.stdout.trim()} · ${resolved.config.model} responded: ${r.text.trim().slice(0, 80)}`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const e = err as RuntimeError;
      return { ok: false, message: e.message ?? "Connection failed", detail: e.detail, durationMs: Date.now() - started };
    }
  },
};

/* ---------------------------------------------------------------- session slash commands

   Claude Code answers `/context` locally (no model call, session untouched)
   and performs `/compact` inside the resumed session — its own summarization,
   same session id. Both are how Nexora reads and manages real context without
   ever summarizing a conversation itself.                                    */

export type SlashResult = { ok: boolean; text: string; error?: string };

export async function claudeSlash(
  resolved: ResolvedRuntime,
  opts: { sessionId: string; cwd: string; command: "/context" | "/compact"; timeoutMs?: number }
): Promise<SlashResult> {
  let bin: string;
  try {
    bin = locate();
  } catch (err) {
    return { ok: false, text: "", error: (err as RuntimeError).message };
  }
  const args = ["-p", "--output-format", "json", "--model", resolved.config.model, "--resume", opts.sessionId, opts.command];
  const res = await runCli(bin, args, { cwd: opts.cwd, env: envFor(resolved), timeoutMs: opts.timeoutMs ?? 600_000 });
  if (res.timedOut) return { ok: false, text: "", error: `Claude Code timed out running ${opts.command}.` };
  const out = parseOutput(res.stdout);
  if (!out) return { ok: false, text: "", error: `Claude Code returned no parseable output for ${opts.command}. ${tail(res.stderr, 300)}` };
  if (out.is_error || (out.subtype && out.subtype !== "success")) {
    return { ok: false, text: "", error: `Claude Code reported ${out.subtype ?? "an error"} for ${opts.command}${out.result ? `: ${out.result.slice(0, 300)}` : ""}` };
  }
  return { ok: true, text: out.result ?? "" };
}

/** Parse "**Tokens:** 23.2k / 1m (2%)" out of the /context report. */
export function parseClaudeContext(text: string): { usedTokens: number; windowTokens: number } | null {
  const m = text.match(/\*\*Tokens:\*\*\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i);
  if (!m) return null;
  const used = parseTokenValue(m[1]);
  const window = parseTokenValue(m[2]);
  return used == null || window == null ? null : { usedTokens: used, windowTokens: window };
}

function parseTokenValue(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^([\d.]+)\s*([km]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1));
}

export { agentWorkspace as claudeWorkspace };
