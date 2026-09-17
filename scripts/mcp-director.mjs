#!/usr/bin/env node
/* ------------------------------------------------------------------
   Nexora OS — stdio MCP server exposing the PROJECT DIRECTOR's orchestration
   tools to the Director agent's CLI runtime (ported/adapted from Tandem's
   mcp-director.cjs). Every call is forwarded to the app, which enforces the
   deterministic invariants (dependencies, cycles, isolation, review policy),
   persists the decision, and records project activity.

   Env: NEXORA_INTERNAL_URL, NEXORA_INTERNAL_TOKEN, NEXORA_PROJECT_ID
   ------------------------------------------------------------------ */
import readline from "node:readline";

const BASE = process.env.NEXORA_INTERNAL_URL || "";
const TOKEN = process.env.NEXORA_INTERNAL_TOKEN || "";
const PROJECT_ID = process.env.NEXORA_PROJECT_ID || "";

const TOOLS = [
  { name: "project_get_state", description: "Fetch the live project state: milestones, sessions, statuses, dependencies, recent activity. Use it whenever you need fresher detail than the snapshot at the top of your turn.", inputSchema: { type: "object", properties: {} } },
  { name: "project_set_plan", description: "Submit or revise the MASTER PLAN as milestones only — do not pre-plan sessions here. Each milestone needs a short unique key (M1, M2…), a name, a concrete goal, checkable acceptance criteria, and its dependencies (keys of milestones that must complete first). The plan is independently reviewed after your turn; you will receive the verdict or findings.",
    inputSchema: { type: "object", properties: { title: { type: "string", description: "Short project title." }, summary: { type: "string", description: "One-paragraph summary of the overall approach." }, milestones: { type: "array", description: "The full milestone list, in intended order.", items: { type: "object", properties: { key: { type: "string" }, name: { type: "string" }, goal: { type: "string" }, acceptance: { type: "string" }, depends_on: { type: "array", items: { type: "string" } } }, required: ["key", "name", "goal", "acceptance"] } } }, required: ["milestones", "summary"] } },
  { name: "plan_milestone_sessions", description: "Decompose ONE milestone into sessions, just in time — after inspecting the actual repository state. Each session becomes a build session with its own Builder agent and independent Reviewer. Write each prompt as a full self-contained contract (goal, context, constraints, definition of done) — the session knows nothing about this conversation. Set isolated=true for sessions that should run in parallel with siblings touching the same repository (each gets its own git worktree and branch); leave it false for sequential work in the shared project directory. Optionally choose a Builder agent with agent_id from the AVAILABLE BUILDER AGENTS list in your instructions.",
    inputSchema: { type: "object", properties: { milestone: { type: "string" }, reasoning: { type: "string", description: "Why this decomposition — recorded as a project decision." }, sessions: { type: "array", items: { type: "object", properties: { key: { type: "string", description: "Unique key within the project, e.g. S2.1" }, name: { type: "string" }, purpose: { type: "string" }, prompt: { type: "string", description: "Complete self-contained instructions for the session's Builder." }, depends_on: { type: "array", items: { type: "string" } }, isolated: { type: "boolean" }, agent_id: { type: "string" } }, required: ["key", "name", "purpose", "prompt"] } } }, required: ["milestone", "sessions", "reasoning"] } },
  { name: "start_sessions", description: "Start the listed planned sessions now. The engine refuses any session whose dependencies are unfinished or whose shared directory is occupied. You are woken when they finish, fail, or time out.", inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } }, timeout_minutes: { type: "number", description: "Per-session time budget in minutes (default 30, max 90)." } }, required: ["keys"] } },
  { name: "resume_sessions", description: "Resume paused sessions. Each continues its OWN existing Builder conversation — completed work is never redone. Dependencies are enforced.", inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } }, note: { type: "string" } }, required: ["keys"] } },
  { name: "recover_session", description: "Decide how to handle a session that timed out or failed. This is a SIGNIFICANT decision: it is independently reviewed (max two reviews; your second revision applies without further review). Actions: continue, restart (fresh run, optionally with a rewritten prompt), abandon, wait.", inputSchema: { type: "object", properties: { key: { type: "string" }, action: { type: "string", enum: ["continue", "restart", "abandon", "wait"] }, reasoning: { type: "string" }, new_prompt: { type: "string" }, extra_minutes: { type: "number" } }, required: ["key", "action", "reasoning"] } },
  { name: "integrate_milestone", description: "Start the milestone's integration session: a session on the project integration branch that merges the completed session branches, resolves conflicts honestly, and runs the validations you specify. Requires every milestone session to be completed or abandoned.", inputSchema: { type: "object", properties: { milestone: { type: "string" }, instructions: { type: "string" }, timeout_minutes: { type: "number" } }, required: ["milestone", "instructions"] } },
  { name: "complete_milestone", description: "Mark a milestone complete — only when its acceptance criteria actually hold (typically after its integration session passed).", inputSchema: { type: "object", properties: { milestone: { type: "string" }, summary: { type: "string" } }, required: ["milestone", "summary"] } },
  { name: "project_deliver", description: "Deliver the finished work: fast-forward the project's base branch to the integration branch and check it out. Call it when all milestones are complete, before complete_project.", inputSchema: { type: "object", properties: {} } },
  { name: "complete_project", description: "Mark the whole project complete when every milestone is done and the work is delivered.", inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
  { name: "project_need_user", description: "Pause orchestration because a genuine decision belongs to the owner. Ask the question in your chat reply; their next message resumes you.", inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

async function callTool(name, args) {
  const res = await fetch(`${BASE}/api/internal/director`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, projectId: PROJECT_ID, op: name, args: args || {} }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) return { content: [{ type: "text", text: `Director engine: ${body.error || "error"}` }], isError: true };
  return { content: [{ type: "text", text: body.text || "ok" }] };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") reply(id, { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "director", version: "1.0.0" } });
  else if (method && method.startsWith("notifications/")) { /* none */ }
  else if (method === "tools/list") reply(id, { tools: TOOLS });
  else if (method === "tools/call") {
    const name = params && params.name;
    if (!TOOLS.some((t) => t.name === name)) return reply(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
    callTool(name, params && params.arguments).then((r) => reply(id, r)).catch((err) => reply(id, { content: [{ type: "text", text: `Tool call failed: ${String(err)}` }], isError: true }));
  } else if (method === "ping") reply(id, {});
  else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not implemented: ${method}` } });
});
rl.on("close", () => process.exit(0));
