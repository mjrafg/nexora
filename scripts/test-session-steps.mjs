#!/usr/bin/env node
/* ------------------------------------------------------------------
   A session remembers what it did.

   The live bus is an in-memory ring: before this, every command and
   file change a build made vanished when the process restarted, and a
   finished session could only be inspected through its summary. This
   runs a real session, restarts nothing, then reads the steps back from
   the store on disk — the only place that survives a restart.

     node scripts/test-session-steps.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const USER = process.env.NEXORA_USER || "mjrafg";
const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data");
const TOKEN = fs.readFileSync(path.join(DATA_DIR, "internal-token"), "utf8").trim();

function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}
let cookie = "";
async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}
const director = async (projectId, op, args = {}) => {
  const r = await fetch(`${BASE}/api/internal/director`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN, projectId, op, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${op} -> ${j.error}`);
  return j;
};
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: requirePassword() }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const cat = await api("/api/catalog");
const conns = (await api("/api/providers")).connections;
let runtime = null;
for (const o of [
  { runtimeType: "claude-code", providerConnectionId: "conn-anthropic", model: cat.defaults?.model ?? "claude-haiku-4-5" },
  { runtimeType: "codex", providerConnectionId: "conn-openai", model: cat.defaults?.codexModel ?? "gpt-5-codex" },
].filter((o) => conns.some((c) => c.id === o.providerConnectionId))) {
  const { agent } = await api("/api/agents", { name: `STEP probe ${Date.now().toString(36).slice(-5)}`, role: "Analyst", dept: "operations", toolPermissions: [], instructions: "Answer briefly.", runtime: o });
  const t = await api(`/api/agents/${agent.id}/test`, { message: "Reply with the single word ready." }).catch((e) => ({ ok: false, message: String(e.message) }));
  await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => {});
  console.log(`  ${o.runtimeType}/${o.model}: ${t.ok ? "available" : `unavailable — ${String(t.message).slice(0, 70)}`}`);
  if (t.ok) { runtime = o; break; }
}
assert(runtime, "no CLI runtime is available — a real session cannot run");

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-steps-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), "# Steps test\n");
git("init", "-q", "-b", "main"); git("config", "user.email", "steps@nexora.local"); git("config", "user.name", "steps test");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions: "Do the work you are given." , runtime});
  made.push(agent.id); return agent;
};

let projectId = null;
try {
  const dir = await mk(`STEP Director ${tag}`, "Project Director", ["read_files"]);
  const bld = await mk(`STEP Builder ${tag}`, "Engineer", ["read_files", "write_files", "run_commands"]);
  const rev = await mk(`STEP Reviewer ${tag}`, "Reviewer", ["read_files"]);
  const { project } = await api("/api/projects", { title: `Steps test ${tag}`, rootPath: root, goal: "One small piece of work.", directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id });
  projectId = project.id;
  await director(projectId, "set_plan", { summary: "One milestone.", milestones: [{ key: "M1", name: "Work", goal: "Add a file.", acceptance: "The file exists.", depends_on: [] }] });
  await director(projectId, "plan_sessions", {
    milestone: "M1", reasoning: "Harness-driven plan.",
    sessions: [{ key: "S1", name: "Add a greeting", purpose: "small real work",
      prompt: "Create hello.js that prints 'hello'. Run it with node to confirm it works, then append a line to README.md describing it.", depends_on: [], isolated: true, kind: "build", review_policy: "required" }],
  });

  const byKey = () => store().projectSessions.find((s) => s.projectId === projectId && s.key === "S1");
  await director(projectId, "start_sessions", { keys: ["S1"], timeout_minutes: 10 });
  for (let i = 0; i < 180 && !["completed", "needs_attention", "paused"].includes(byKey()?.status); i++) await sleep(2_000);
  const s1 = byKey();
  assert(s1 && s1.status !== "running", `S1 never settled (${s1?.status})`);
  console.log(`  S1 settled as ${s1.status}`);

  await test("the session kept what it actually did, on disk", async () => {
    const s = byKey();
    assert(Array.isArray(s.steps) && s.steps.length > 0, "no steps were stored");
    const kinds = [...new Set(s.steps.map((e) => e.kind))];
    assert(kinds.length > 1, `only one kind of step recorded: ${kinds}`);
    return `${s.steps.length} steps · kinds: ${kinds.join(", ")}`;
  });

  await test("every step belongs to this session, and agent steps say who did them", async () => {
    const s = byKey();
    // Two kinds of step live here: what an agent did, which names the agent,
    // and Nexora's own markers for the session ("review round 1 started"),
    // which have no agent because no agent produced them. What must hold for
    // both is that nothing from another session leaked in.
    const byAgent = s.steps.filter((e) => e.actor);
    const engine = s.steps.filter((e) => !e.actor);
    assert(byAgent.length > 0, "no step names the agent that produced it");
    assert(byAgent.every((e) => e.actor.sessionKey === "S1"), "a step from another session was stored here");
    assert(engine.every((e) => e.turnId === "session:S1"), `an unattributed step belongs elsewhere: ${engine.map((e) => e.turnId)}`);
    const roles = [...new Set(byAgent.map((e) => e.actor.role))];
    const names = [...new Set(byAgent.map((e) => e.actor.name))];
    return `${byAgent.length} by ${names.join(", ")} (${roles.join(", ")}) · ${engine.length} engine marker(s)`;
  });

  await test("the real work is visible in them, not just status lines", async () => {
    const s = byKey();
    const doing = s.steps.filter((e) => ["command", "tool", "file"].includes(e.kind));
    assert(doing.length > 0, `no commands, tools or file changes recorded — only ${[...new Set(s.steps.map((e) => e.kind))]}`);
    return doing.slice(0, 3).map((e) => `${e.kind}:${String(e.title).slice(0, 40)}`).join(" | ");
  });

  await test("it survives a restart, which is the whole point", async () => {
    // the store on disk is the only thing that outlives the process
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"))
      .projectSessions.find((x) => x.projectId === projectId && x.key === "S1");
    assert(onDisk?.steps?.length, "the steps are not in the persisted store");
    return `${onDisk.steps.length} steps readable from ${path.basename(DATA_DIR)}/nexora.json`;
  });

  await test("one session's record cannot grow without bound", async () => {
    const s = byKey();
    const bytes = JSON.stringify(s.steps).length;
    assert(s.steps.length <= 300, `${s.steps.length} steps stored, cap is 300`);
    assert(bytes <= 420_000, `${bytes} bytes stored, budget is 400k`);
    return `${bytes.toLocaleString()} bytes for ${s.steps.length} steps`;
  });

  await test("the API hands them to the page", async () => {
    const d = await api(`/api/projects/${projectId}`);
    const s = d.project.milestones.flatMap((m) => m.sessions).find((x) => x.key === "S1");
    assert(s?.steps?.length, "the project view does not carry the steps");
    return `${s.steps.length} steps in the project view`;
  });

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
} finally {
  if (!KEEP) {
    // delete by id, and sweep any project still pointing at this throwaway
    // repository — the Director can rename a project, so a title is no handle
    if (projectId) await api(`/api/projects/${projectId}`, null, "DELETE").catch(() => {});
    for (const p of (await api("/api/projects").catch(() => ({ projects: [] }))).projects ?? []) {
      if (p.rootPath === root) await api(`/api/projects/${p.id}`, null, "DELETE").catch(() => {});
    }
    for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => {});
    for (const d of [root, path.join(path.dirname(root), ".nexora-worktrees")]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
    console.log("cleaned up");
  } else console.log(`kept: project ${projectId} · repo ${root}`);
}
process.exit(results.every(Boolean) ? 0 : 1);
