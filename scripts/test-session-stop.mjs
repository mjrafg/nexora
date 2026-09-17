#!/usr/bin/env node
/* ------------------------------------------------------------------
   Stopping one session.

   The promise: the rest of the project carries on, the work on the
   branch is kept, and the session is recorded as STOPPED — not as a
   failure the Director has to recover from.

   It needs a Builder that will actually sit there for a moment, so it
   uses whichever CLI runtime answers. Without one it says so and stops
   rather than pretending to have checked.

     node scripts/test-session-stop.mjs [baseUrl] [--keep]
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
  const { agent } = await api("/api/agents", { name: `STOP probe ${Date.now().toString(36).slice(-5)}`, role: "Analyst", dept: "operations", toolPermissions: [], instructions: "Answer briefly.", runtime: o });
  const t = await api(`/api/agents/${agent.id}/test`, { message: "Reply with the single word ready." }).catch((e) => ({ ok: false, message: String(e.message) }));
  await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => {});
  console.log(`  ${o.runtimeType}/${o.model}: ${t.ok ? "available" : `unavailable — ${String(t.message).slice(0, 80)}`}`);
  if (t.ok) { runtime = o; break; }
}
assert(runtime, "no CLI runtime is available — a Builder cannot run, so stopping one cannot be tested");

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-stop-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "notes.md"), "# Notes\n");
git("init", "-q", "-b", "main"); git("config", "user.email", "stop@nexora.local"); git("config", "user.name", "stop test");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions: "Do the work you are given.", runtime });
  made.push(agent.id); return agent;
};

let projectId = null;
try {
  const dir = await mk(`STOP Director ${tag}`, "Project Director", ["read_files"]);
  const bld = await mk(`STOP Builder ${tag}`, "Engineer", ["read_files", "write_files", "run_commands"]);
  const bld2 = await mk(`STOP Builder B ${tag}`, "Engineer", ["read_files", "write_files", "run_commands"]);
  const rev = await mk(`STOP Reviewer ${tag}`, "Reviewer", ["read_files"]);
  const { project } = await api("/api/projects", { title: `Stop test ${tag}`, rootPath: root, goal: "Two slow pieces of work.", directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id });
  projectId = project.id;
  await director(projectId, "set_plan", { summary: "One milestone, two sessions.", milestones: [{ key: "M1", name: "Work", goal: "Write two notes.", acceptance: "Both files exist.", depends_on: [] }] });
  await director(projectId, "plan_sessions", {
    milestone: "M1", reasoning: "Harness-driven plan.",
    sessions: [
      { key: "S1", name: "Long one", purpose: "the session that gets stopped", agent_id: bld.id,
        prompt: "Create forty markdown files named part-01.md through part-40.md. Write each one separately, one tool call per file, and put three full paragraphs of original prose in each about a different aspect of software maintenance. Do not use a loop or a script — write every file individually. After each file, read it back to confirm it was written.", depends_on: [], isolated: true, kind: "build", review_policy: "required" },
      { key: "S2", name: "Short one", purpose: "the session that must be left alone", agent_id: bld2.id,
        prompt: "Create six markdown files named note-1.md through note-6.md, each containing one short paragraph about testing.", depends_on: [], isolated: true, kind: "build", review_policy: "required" },
    ],
  });

  const sessions = () => store().projectSessions.filter((s) => s.projectId === projectId);
  const byKey = (k) => sessions().find((s) => s.key === k);

  await director(projectId, "start_sessions", { keys: ["S1", "S2"], timeout_minutes: 10 });
  for (let i = 0; i < 40 && byKey("S1")?.status !== "running"; i++) await sleep(500);
  assert(byKey("S1")?.status === "running", `S1 never started (${byKey("S1")?.status})`);
  await sleep(8_000); // let the Builder actually get going
  // if it already finished, there is nothing to stop and nothing to learn —
  // say that rather than reporting a pass for work that ended on its own
  assert(byKey("S1")?.status === "running", `S1 finished before it could be stopped (${byKey("S1")?.status}) — the task was not long enough to measure`);
  const busyBefore = (await api("/api/office")).totals.working;
  const builderBusyBefore = (await api("/api/agents")).agents.find((a) => a.id === bld.id)?.state;

  await test("a running session can be stopped on its own", async () => {
    const r = await api(`/api/projects/${projectId}/sessions/S1/stop`, {});
    assert(r.ok, "the stop was refused");
    for (let i = 0; i < 60 && byKey("S1")?.status === "running"; i++) await sleep(500);
    const st = byKey("S1").status;
    assert(st !== "running", "S1 is still running 30s after Stop");
    assert(st !== "completed", "S1 ran to completion anyway — the stop did not take effect");
    return `S1 is now ${st}`;
  });

  await test("it is recorded as stopped, not as something that failed", async () => {
    const s1 = byKey("S1");
    assert(s1.status === "paused", `S1 is ${s1.status}, expected paused`);
    assert(s1.stopReason === "user_stop", `stopReason is ${s1.stopReason}`);
    assert(!s1.errorText, `it recorded an error: ${s1.errorText}`);
    return `paused · ${s1.stopReason}`;
  });

  await test("the project keeps running and the other session is untouched", async () => {
    const p = (await api(`/api/projects/${projectId}`)).project;
    assert(p.state !== "PAUSED" && p.state !== "PAUSING", `the whole project went to ${p.state}`);
    const s2 = byKey("S2");
    assert(s2.stopReason !== "user_stop", "S2 was stopped too");
    return `project ${p.state} · S2 ${s2.status}`;
  });

  await test("the Director is told it can be resumed, rather than asked to recover a failure", async () => {
    const acts = store().projectActivity.filter((a) => a.projectId === projectId);
    const line = acts.find((a) => /S1 preserved/.test(a.text));
    assert(line, `no preservation line: ${acts.slice(-4).map((a) => a.text).join(" | ")}`);
    // the observation is queued while the Director is mid-turn and written when
    // it next runs, so give it until the other session has finished
    let told = null;
    for (let i = 0; i < 60 && !told; i++) {
      told = store().projectMessages.find((m) => m.projectId === projectId && m.role === "observation" && /S1 was STOPPED/.test(m.content));
      if (!told) await sleep(3_000);
    }
    assert(told, "the Director was never told the session was stopped, even after waiting for it to be free");
    assert(/resume_sessions/.test(told.content), "the Director was not offered resume_sessions");
    return `${line.text} · Director told, offered resume_sessions`;
  });

  await test("the work it had already done is still on disk", async () => {
    const s1 = byKey("S1");
    assert(s1.cwd, "the session recorded no worktree");
    assert(fs.existsSync(s1.cwd), `the worktree was removed: ${s1.cwd}`);
    return `worktree kept at ${path.basename(s1.cwd)}`;
  });

  await test("stopping something that is not running says so instead of pretending", async () => {
    const r = await fetch(`${BASE}/api/projects/${projectId}/sessions/S1/stop`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    const j = await r.json();
    assert(!r.ok && /not running/i.test(j.error ?? ""), `second stop returned ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    return j.error;
  });

  await test("the agent that was running it is no longer working", async () => {
    const after = (await api("/api/agents")).agents.find((a) => a.id === bld.id)?.state;
    assert(after !== "WORKING", `the stopped session's builder is still ${after}`);
    const total = (await api("/api/office")).totals.working;
    return `its builder ${builderBusyBefore} → ${after} · floor working ${busyBefore} → ${total}`;
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
