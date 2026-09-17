#!/usr/bin/env node
/* ------------------------------------------------------------------
   Mock side-effect MCP server (stdio) for the duplicate-execution tests.
   Counts every provider call in MOCK_LOG (one JSON line per call) so tests
   can assert how many times the "provider" was really invoked.

   Tools: sendEmail (side effect), searchEmails (read), purchase (financial),
   createRecord (side effect, declares idempotencyKey).
   Arg `mode`: "ok" (default) | "fail" (confirmed failure, nothing done) |
   "hang" (accepted but never answers → client timeout → UNCERTAIN).
   ------------------------------------------------------------------ */
import fs from "node:fs";
import readline from "node:readline";

const LOG = process.env.MOCK_LOG || "/tmp/mock-sideeffect-calls.jsonl";
let seq = 0;
const TOOLS = [
  { name: "sendEmail", description: "Send an email through the mock provider.", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, mode: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "searchEmails", description: "Search the mock mailbox (read-only).", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "purchase", description: "Buy something with the company card (mock, no money moves).", inputSchema: { type: "object", properties: { item: { type: "string" }, amountUsd: { type: "number" }, mode: { type: "string" } }, required: ["item", "amountUsd"] } },
  { name: "createRecord", description: "Create a record; supports a native idempotencyKey.", inputSchema: { type: "object", properties: { name: { type: "string" }, idempotencyKey: { type: "string" }, mode: { type: "string" } }, required: ["name"] } },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + "\n");

function call(name, args) {
  const mode = args.mode || "ok";
  if (name === "searchEmails") {
    log({ tool: name, args });
    return { content: [{ type: "text", text: JSON.stringify({ results: [{ messageId: "m-1", subject: "hello" }], query: args.query ?? "" }) }] };
  }
  if (mode === "fail") return { content: [{ type: "text", text: "Provider rejected the request: invalid recipient (nothing was sent)." }], isError: true };
  if (mode === "hang") { log({ tool: name, args, note: "accepted-but-hung" }); return null; }
  seq += 1;
  log({ tool: name, args });
  if (name === "sendEmail") return { content: [{ type: "text", text: JSON.stringify({ status: "sent", messageId: `mock-msg-${Date.now()}-${seq}`, to: args.to }) }] };
  if (name === "purchase") return { content: [{ type: "text", text: JSON.stringify({ status: "charged", transactionId: `mock-txn-${seq}`, amountUsd: args.amountUsd }) }] };
  if (name === "createRecord") return { content: [{ type: "text", text: JSON.stringify({ status: "created", recordId: `rec-${seq}`, idempotencyKey: args.idempotencyKey ?? null }) }] };
  return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") reply(id, { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock_sideeffect", version: "1.0.0" } });
  else if (method && method.startsWith("notifications/")) { /* none */ }
  else if (method === "tools/list") reply(id, { tools: TOOLS });
  else if (method === "tools/call") { const r = call(params.name, params.arguments || {}); if (r) reply(id, r); /* null = hang */ }
  else if (method === "ping") reply(id, {});
  else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not implemented: ${method}` } });
});
rl.on("close", () => process.exit(0));
