/* Codex runtime: executes agent turns through the OpenAI `codex` CLI. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS } from "../catalog";
import type { AgentRuntime, ResolvedRuntime, RuntimeChatRequest, RuntimeChatResult, RuntimeTestResult } from "../types";
import { RuntimeError } from "../types";
import { agentWorkspace, childEnv, findBinary, renderTranscript, runCli, tail, type Env } from "./cli";
import { buildCodexHome } from "./mcp-cli";

export const CODEX_CANDIDATES = [
  process.env.CODEX_BIN ?? "",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

function locate(): string {
  const bin = findBinary("codex", CODEX_CANDIDATES);
  if (!bin) throw new RuntimeError("Codex CLI not found", "Install the Codex CLI (npm i -g @openai/codex) or set CODEX_BIN.");
  return bin;
}

function envFor(resolved: ResolvedRuntime): Env {
  const extra: Env = {};
  if (resolved.secret) extra.OPENAI_API_KEY = resolved.secret;
  const base = resolved.connection.baseUrl;
  if (base && base !== PROVIDERS.openai.defaultBaseUrl) extra.OPENAI_BASE_URL = base;
  return childEnv(extra);
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** Model configured in the user's ~/.codex/config.toml, if any. */
export function configuredCodexModel(): string | null {
  try {
    const toml = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
    const m = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Models the local Codex install can actually use, from its on-disk catalog cache
 * (~/.codex/models_cache.json). Returns null when the cache is missing.
 */
export function codexModelCatalog(): { id: string; label: string }[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(codexHome(), "models_cache.json"), "utf8")) as {
      models?: { slug?: string; display_name?: string; visibility?: string }[];
    };
    const models = (raw.models ?? [])
      .filter((m) => m.slug && m.visibility !== "hide")
      .map((m) => ({ id: m.slug!, label: m.display_name ?? m.slug! }));
    return models.length ? models : null;
  } catch {
    return null;
  }
}

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
};

/** Codex sometimes wraps the provider's JSON error body in the message string. */
function unwrapError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return message;
  try {
    const j = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
    return j.error?.message || j.message || message;
  } catch {
    return message;
  }
}

function parseEvents(stdout: string): CodexEvent[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as CodexEvent];
      } catch {
        return [];
      }
    });
}

async function invoke(
  req: Pick<RuntimeChatRequest, "resolved"> & { prompt: string; cwd: string; writable: boolean; codexHome?: string; emit?: import("@/lib/activity").TurnEmitter; onSpawn?: (kill: () => void) => void; timeoutMs?: number; silentServers?: string[] }
): Promise<RuntimeChatResult> {
  const bin = locate();
  const { config } = req.resolved;
  const lastMsgFile = path.join(os.tmpdir(), `nexora-codex-${process.pid}-${Date.now()}.txt`);

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color", "never",
    "-C", req.cwd,
    "-m", config.model,
    "-s", req.writable ? "workspace-write" : "read-only",
    "-o", lastMsgFile,
  ];
  if (config.advancedSettings.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${config.advancedSettings.reasoningEffort}"`);
  }
  args.push("-"); // prompt from stdin

  const started = Date.now();
  const env = req.codexHome ? { ...envFor(req.resolved), CODEX_HOME: req.codexHome } : envFor(req.resolved);
  const onLine = (line: string) => {
    line = line.trim();
    if (!line.startsWith("{")) return;
    let ev: CodexEvent & Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { return; }
    const item = (ev.item ?? {}) as Record<string, unknown>;
    const itype = String(item.type ?? "");
    if (itype === "mcp_tool_call" && req.silentServers?.includes(String(item.server ?? ""))) return; // self-recording server
    if (ev.type === "item.started" || ev.type === "item.updated") {
      if (itype === "command_execution") req.emit?.event({ id: String(item.id ?? ""), kind: "command", title: String(item.command ?? "shell").slice(0, 120), meta: "Shell", detail: String(item.command ?? "").slice(0, 500), status: "running" });
      else if (itype === "mcp_tool_call") req.emit?.event({ id: String(item.id ?? ""), kind: "tool", title: String(item.tool ?? "tool"), meta: String(item.server ?? "mcp"), detail: JSON.stringify(item.arguments ?? {}).slice(0, 500), status: "running" });
      else if (itype === "file_change") req.emit?.event({ id: String(item.id ?? ""), kind: "file", title: String(item.path ?? "file").slice(0, 120), meta: "File change", detail: String(item.path ?? "").slice(0, 300), status: "running" });
    } else if (ev.type === "item.completed") {
      if (itype === "command_execution") req.emit?.event({ id: String(item.id ?? ""), kind: "command", title: String(item.command ?? "shell").slice(0, 120), meta: "Shell", detail: String(item.command ?? "").slice(0, 500), output: String(item.aggregated_output ?? item.output ?? "").slice(0, 2000), status: Number(item.exit_code ?? 0) === 0 ? "done" : "failed" });
      else if (itype === "mcp_tool_call") req.emit?.event({ id: String(item.id ?? ""), kind: "tool", title: String(item.tool ?? "tool"), meta: String(item.server ?? "mcp"), output: JSON.stringify(item.result ?? "").slice(0, 2000), status: item.status === "failed" ? "failed" : "done" });
      else if (itype === "file_change") req.emit?.event({ id: String(item.id ?? ""), kind: "file", title: String(item.path ?? "file").slice(0, 120), meta: "File change", detail: String(item.path ?? "").slice(0, 300), status: "done" });
    }
  };
  const res = await runCli(bin, args, { cwd: req.cwd, env, input: req.prompt, timeoutMs: req.timeoutMs ?? 600_000, onLine, onSpawn: req.onSpawn });
  const events = parseEvents(res.stdout);

  let text = "";
  try {
    text = fs.readFileSync(lastMsgFile, "utf8").trim();
    fs.unlinkSync(lastMsgFile);
  } catch {
    /* fall back to events */
  }
  if (!text) {
    const msgs = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message");
    text = msgs.at(-1)?.item?.text?.trim() ?? "";
  }

  if (res.timedOut) throw new RuntimeError("Codex timed out", tail(res.stderr));
  const errEvent = events.find((e) => e.type === "error" || e.type === "turn.failed");
  if (errEvent && !text) {
    throw new RuntimeError(unwrapError(errEvent.error?.message || errEvent.message || "Codex reported an error"), tail(res.stderr));
  }
  if (res.code !== 0 && !text) {
    throw new RuntimeError("Codex exited with an error", tail(res.stderr || res.stdout));
  }
  if (!text) throw new RuntimeError("Codex returned no message", tail(res.stderr || res.stdout));

  const usage = events.find((e) => e.type === "turn.completed")?.usage;
  const threadId = events.find((e) => e.type === "thread.started")?.thread_id;
  return {
    text,
    sessionId: threadId,
    usage: { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, durationMs: Date.now() - started },
  };
}

export const codexRuntime: AgentRuntime = {
  type: "codex",

  async chat(req) {
    const cwd = req.cwdOverride ?? agentWorkspace(req.agent.id, req.resolved.config.advancedSettings.workingDirectory);
    const writable =
      req.toolProfile === "builder" ? true
      : req.toolProfile === "reader" ? false
      : req.agent.toolPermissions.includes("write_files") || req.agent.toolPermissions.includes("run_commands");
    // Codex has no separate system-prompt flag: instructions lead the prompt.
    const prompt = `${req.systemPrompt}\n\n---\n\n${req.freshPrompt ? req.message : renderTranscript(req.history, req.message)}`;
    const home = await buildCodexHome(req.mcpTools, process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), req.extraServers);
    try {
      const silentServers = (req.silentToolPrefixes ?? []).map((p) => p.replace(/^mcp__/, "").replace(/__$/, ""));
      return await invoke({ resolved: req.resolved, prompt, cwd, writable, codexHome: home?.codexHome, emit: req.emit, onSpawn: req.onSpawn, timeoutMs: req.timeoutMs, silentServers });
    } finally {
      home?.cleanup();
    }
  },

  async test(resolved): Promise<RuntimeTestResult> {
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
      return { ok: false, message: "Codex CLI failed to start", detail: tail(version.stderr), durationMs: Date.now() - started };
    }
    try {
      const r = await invoke({
        resolved,
        prompt: "You are a connectivity probe. Reply with exactly the single word: OK",
        cwd: agentWorkspace("_runtime-test"),
        writable: false,
      });
      return {
        ok: true,
        message: "Connected",
        detail: `${version.stdout.trim()} · ${resolved.config.model} responded: ${r.text.slice(0, 80)}`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const e = err as RuntimeError;
      return { ok: false, message: e.message ?? "Connection failed", detail: e.detail, durationMs: Date.now() - started };
    }
  },
};
