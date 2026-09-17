/* Direct API runtime: Anthropic Messages API, or any OpenAI-compatible chat endpoint. */

import Anthropic from "@anthropic-ai/sdk";
import { PROVIDERS } from "../catalog";
import type { AgentRuntime, ResolvedRuntime, RuntimeChatRequest, RuntimeChatResult, RuntimeTestResult } from "../types";
import type { ToolCallRecord } from "@/lib/mcp/types";
import { turnEmitter } from "@/lib/activity";
import { RuntimeError } from "../types";

const DEFAULT_MAX_TOKENS = 4096;

/** in-app tool names are <slug>__<tool>; silent prefixes arrive as mcp__<slug>__ */
function isSilent(req: RuntimeChatRequest, fullName: string): boolean {
  return (req.silentToolPrefixes ?? []).some((p) => fullName.startsWith(p.replace(/^mcp__/, "")));
}

/* ---------- Anthropic ---------- */

async function anthropicChat(req: RuntimeChatRequest): Promise<RuntimeChatResult> {
  const { resolved } = req;
  const client = new Anthropic({
    apiKey: resolved.secret ?? undefined,
    baseURL: resolved.connection.baseUrl || undefined,
    maxRetries: 1,
  });
  const messages: Anthropic.MessageParam[] = [
    ...req.history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: "user", content: req.message },
  ];
  const tools: Anthropic.Tool[] = req.mcpTools.map((t) => ({
    name: t.fullName,
    description: `[${t.serverName}] ${t.description}`.slice(0, 1024),
    input_schema: { type: "object", ...(t.inputSchema ?? {}) } as Anthropic.Tool.InputSchema,
  }));
  const started = Date.now();
  const toolCalls: ToolCallRecord[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  // the LAST call's prompt + completion is the size of the context Nexora is
  // sending; the running totals above are what the whole turn consumed
  let contextTokens: number | undefined;
  // tool rounds per turn: the agent's "max turns" advanced setting, default 6
  const MAX_ROUNDS = Math.min(Math.max(resolved.config.advancedSettings.maxTurns ?? 6, 1), 60);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      req.abortSignal?.throwIfAborted();
      const res = await client.messages.create({
        model: resolved.config.model,
        max_tokens: resolved.config.advancedSettings.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: req.systemPrompt,
        messages,
        ...(tools.length ? { tools } : {}),
        ...(resolved.config.advancedSettings.temperature !== undefined
          ? { temperature: resolved.config.advancedSettings.temperature }
          : {}),
      }, req.abortSignal ? { signal: req.abortSignal } : undefined);
      inputTokens += res.usage.input_tokens;
      outputTokens += res.usage.output_tokens;
      contextTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0) + res.usage.output_tokens;
      if (res.stop_reason === "refusal") {
        throw new RuntimeError("The model declined to answer", res.stop_details?.explanation ?? undefined);
      }
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      if (res.stop_reason !== "tool_use") {
        return { text, toolCalls, usage: { inputTokens, outputTokens, contextTokens, durationMs: Date.now() - started } };
      }
      // Execute each requested tool, then feed results back.
      messages.push({ role: "assistant", content: res.content });
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const args = (use.input ?? {}) as Record<string, unknown>;
        const label = req.mcpTools.find((t) => t.fullName === use.name);
        const silent = isSilent(req, use.name);
        const evId = silent ? null : req.emit.start("tool", label?.toolName ?? use.name, JSON.stringify(args).slice(0, 500), label?.serverName);
        const rec = await req.callTool(use.name, args);
        if (evId) req.emit.finish(evId, "tool", label?.toolName ?? use.name, { output: rec.ok ? rec.result.slice(0, 2000) : rec.error, meta: label?.serverName, status: rec.ok ? "done" : "failed" });
        toolCalls.push(rec);
        // screenshots and other images reach the model as image blocks
        const blocks: Anthropic.ToolResultBlockParam["content"] = rec.images?.length
          ? [
              ...rec.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: img.data } })),
              { type: "text" as const, text: rec.ok ? rec.result || "(no output)" : rec.error ?? "error" },
            ]
          : rec.ok ? rec.result || "(no output)" : rec.error ?? "error";
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: !rec.ok, content: blocks });
      }
      messages.push({ role: "user", content: results });
    }
    return { text: "I stopped after several tool calls without finishing. Please refine the request.", toolCalls, usage: { inputTokens, outputTokens, contextTokens, durationMs: Date.now() - started } };
  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new RuntimeError("Authentication error", err.message);
    if (err instanceof Anthropic.NotFoundError) throw new RuntimeError("Model not found", err.message);
    if (err instanceof Anthropic.RateLimitError) throw new RuntimeError("Rate limited", err.message);
    if (err instanceof Anthropic.APIError) throw new RuntimeError(`Anthropic API error ${err.status ?? ""}`.trim(), err.message);
    throw new RuntimeError("Anthropic request failed", String(err));
  }
}

/* ---------- OpenAI-compatible ---------- */

type OpenAIToolCall = { id: string; type: "function"; function: { name?: string; arguments?: string } };
type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type OpenAIChatResponse = {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
};

async function openaiCompatibleChat(req: RuntimeChatRequest): Promise<RuntimeChatResult> {
  const { resolved } = req;
  const meta = PROVIDERS[resolved.connection.providerType];
  const baseUrl = (resolved.connection.baseUrl || meta.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new RuntimeError("Base URL is required", "Set a base URL on the provider connection.");
  if (!resolved.secret && resolved.connection.providerType !== "custom") {
    throw new RuntimeError("Authentication error", `No API key configured for ${resolved.connection.name}.`);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (resolved.secret) headers.authorization = `Bearer ${resolved.secret}`;
  if (resolved.connection.providerType === "openrouter") {
    headers["HTTP-Referer"] = "https://nexora.local";
    headers["X-Title"] = "Nexora OS";
  }

  const maxTokens = resolved.config.advancedSettings.maxTokens ?? DEFAULT_MAX_TOKENS;
  const messages: OpenAIMessage[] = [
    { role: "system", content: req.systemPrompt },
    ...req.history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: req.message },
  ];
  const tools = req.mcpTools.map((t) => ({
    type: "function" as const,
    function: { name: t.fullName, description: `[${t.serverName}] ${t.description}`.slice(0, 1024), parameters: { type: "object", ...(t.inputSchema ?? {}) } },
  }));

  const started = Date.now();
  const toolCalls: ToolCallRecord[] = [];
  let inTok = 0;
  let outTok = 0;
  // the last call's prompt + completion: the size of the context being sent
  let ctxTok: number | undefined;
  // tool rounds per turn: the agent's "max turns" advanced setting, default 6
  const MAX_ROUNDS = Math.min(Math.max(resolved.config.advancedSettings.maxTurns ?? 6, 1), 60);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body: Record<string, unknown> = { model: resolved.config.model, messages };
    if (resolved.connection.providerType === "openai") body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (resolved.config.advancedSettings.temperature !== undefined) body.temperature = resolved.config.advancedSettings.temperature;
    if (tools.length) body.tools = tools;

    let res: Response;
    try {
      // the owner's Stop aborts the request alongside the ordinary timeout
      const signals = [AbortSignal.timeout(180_000), ...(req.abortSignal ? [req.abortSignal] : [])];
      res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.any(signals) });
    } catch (err) {
      throw new RuntimeError("Could not reach the API", String(err));
    }
    const raw = await res.text();
    let json: OpenAIChatResponse = {};
    try {
      json = JSON.parse(raw) as OpenAIChatResponse;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const msg = json.error?.message || raw.slice(0, 300) || res.statusText;
      if (res.status === 401 || res.status === 403) throw new RuntimeError("Authentication error", msg);
      if (res.status === 404) throw new RuntimeError("Model or endpoint not found", msg);
      if (res.status === 429) throw new RuntimeError("Rate limited", msg);
      throw new RuntimeError(`API error ${res.status}`, msg);
    }
    inTok += json.usage?.prompt_tokens ?? 0;
    outTok += json.usage?.completion_tokens ?? 0;
    ctxTok = (json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0) || undefined;
    const msg = json.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (!calls.length) {
      return { text: msg?.content ?? "", toolCalls, usage: { inputTokens: inTok, outputTokens: outTok, contextTokens: ctxTok, durationMs: Date.now() - started } };
    }
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        /* leave empty */
      }
      const name = call.function?.name ?? "";
      const label = req.mcpTools.find((t) => t.fullName === name);
      const silent = isSilent(req, name);
      const evId = silent ? null : req.emit.start("tool", label?.toolName ?? name, JSON.stringify(args).slice(0, 500), label?.serverName);
      const rec = await req.callTool(name, args);
      if (evId) req.emit.finish(evId, "tool", label?.toolName ?? name, { output: rec.ok ? rec.result.slice(0, 2000) : rec.error, meta: label?.serverName, status: rec.ok ? "done" : "failed" });
      toolCalls.push(rec);
      messages.push({ role: "tool", tool_call_id: call.id, content: rec.ok ? rec.result || "(no output)" : rec.error ?? "error" });
    }
  }
  return { text: "I stopped after several tool calls without finishing. Please refine the request.", toolCalls, usage: { inputTokens: inTok, outputTokens: outTok, contextTokens: ctxTok, durationMs: Date.now() - started } };
}

/* ---------- runtime ---------- */

function styleFor(resolved: ResolvedRuntime) {
  return PROVIDERS[resolved.connection.providerType].apiStyle;
}

export const apiRuntime: AgentRuntime = {
  type: "api",

  chat(req) {
    return styleFor(req.resolved) === "anthropic" ? anthropicChat(req) : openaiCompatibleChat(req);
  },

  async test(resolved): Promise<RuntimeTestResult> {
    const started = Date.now();
    try {
      const r = await apiRuntime.chat({
        agent: { id: "_runtime-test", name: "Probe", role: "", dept: "ceo", instructions: "", skills: [], toolPermissions: [], runtimeConfigId: "", status: "online", mcpGrants: [], createdAt: "", updatedAt: "" },
        systemPrompt: "You are a connectivity probe. Reply with exactly: OK",
        history: [],
        message: "Reply with the single word OK.",
        resolved: { ...resolved, config: { ...resolved.config, advancedSettings: { ...resolved.config.advancedSettings, maxTokens: 16 } } },
        mcpTools: [],
        callTool: async () => ({ server: "", tool: "", args: {}, ok: false, result: "", durationMs: 0 }),
        emit: turnEmitter("_probe", "_probe"),
      });
      return {
        ok: true,
        message: "Connected",
        detail: `${PROVIDERS[resolved.connection.providerType].label} · ${resolved.config.model} responded: ${r.text.trim().slice(0, 80)}`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const e = err as RuntimeError;
      return { ok: false, message: e.message ?? "Connection failed", detail: e.detail, durationMs: Date.now() - started };
    }
  },
};
