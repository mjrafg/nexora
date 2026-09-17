#!/usr/bin/env node
/* ------------------------------------------------------------------
   Nexora OS — generic stdio MCP proxy for Nexora's internal tool servers
   (browser, capability requests, capability-manager operations).

   Adapted from Tandem's mcp-browser.cjs: this process owns nothing. It
   fetches the tool list from the app at start-up (one source of truth) and
   forwards every call over token-authenticated localhost HTTP, streaming
   text + images back to the CLI. The token is a per-turn grant that already
   names the agent, so no identity travels in the body.

   Env: NEXORA_INTERNAL_URL, NEXORA_TURN_TOKEN, NEXORA_TOOL_SERVER
   ------------------------------------------------------------------ */
import readline from "node:readline";

const BASE = process.env.NEXORA_INTERNAL_URL || "";
const TOKEN = process.env.NEXORA_TURN_TOKEN || "";
const SERVER = process.env.NEXORA_TOOL_SERVER || "";

let tools = null;

async function post(body) {
  const res = await fetch(`${BASE}/api/internal/tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, server: SERVER, ...body }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function loadTools() {
  if (tools) return tools;
  const r = await post({ op: "list" });
  tools = Array.isArray(r.tools) ? r.tools : [];
  return tools;
}

async function callTool(name, args) {
  if (!BASE || !TOKEN || !SERVER) {
    return { content: [{ type: "text", text: "Nexora tools unavailable: this invocation has no Nexora connection." }], isError: true };
  }
  try {
    const r = await post({ op: "call", name, args: args || {} });
    if (!Array.isArray(r.content)) return { content: [{ type: "text", text: `${name} failed: ${r.error || "no content"}` }], isError: true };
    return { content: r.content, ...(r.ok === false ? { isError: true } : {}) };
  } catch (err) {
    return { content: [{ type: "text", text: `${name} failed: ${String(err && err.message ? err.message : err).slice(0, 300)}` }], isError: true };
  }
}

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SERVER || "nexora", version: "1.0.0" } });
  } else if (method && method.startsWith("notifications/")) {
    /* none */
  } else if (method === "tools/list") {
    loadTools().then((t) => reply(id, { tools: t })).catch((err) => replyError(id, -32000, `Could not load Nexora tools: ${String(err && err.message ? err.message : err)}`));
  } else if (method === "tools/call") {
    callTool(params && params.name, params && params.arguments)
      .then((r) => reply(id, r))
      .catch((err) => reply(id, { content: [{ type: "text", text: `Tool call failed: ${String(err)}` }], isError: true }));
  } else if (method === "ping") {
    reply(id, {});
  } else if (id !== undefined) {
    replyError(id, -32601, `Method not implemented: ${method}`);
  }
});
rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
