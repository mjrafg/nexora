#!/usr/bin/env node
/* ------------------------------------------------------------------
   stdio ⇄ Streamable-HTTP MCP bridge.

   External CLIs (Claude Code, Codex) speak stdio MCP reliably but mishandle
   some remote HTTP transports (SSE framing, OAuth). This bridge lets the CLI
   talk plain newline-delimited JSON-RPC over stdio while we forward each
   message to the remote Streamable-HTTP MCP endpoint with the right headers
   (including the OAuth bearer) and stream replies back.

   Config via env: MCP_URL (required), MCP_HEADERS (JSON object, optional).
   No app imports — self-contained so it can run under any CLI's spawn.
   ------------------------------------------------------------------ */
import readline from "node:readline";

const URL_ = process.env.MCP_URL;
const HEADERS = (() => { try { return JSON.parse(process.env.MCP_HEADERS || "{}"); } catch { return {}; } })();
if (!URL_) { process.stderr.write("mcp-http-bridge: MCP_URL is required\n"); process.exit(1); }

let sessionId = null;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

async function forward(msg) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...HEADERS,
    },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(120000),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) {
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: res.status, message: `HTTP ${res.status}: ${text.slice(0, 300)}` } });
    return;
  }
  let json = null;
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("text/event-stream")) {
    for (const line of text.split("\n")) if (line.startsWith("data:")) { try { json = JSON.parse(line.slice(5).trim()); } catch {} }
  } else if (text.trim()) {
    try { json = JSON.parse(text); } catch {}
  }
  if (json !== null && msg.id !== undefined) out(json);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  forward(msg).catch((err) => {
    if (msg && msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(err && err.message || err) } });
  });
});
