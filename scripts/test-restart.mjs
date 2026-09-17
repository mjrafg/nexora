#!/usr/bin/env node
/* ------------------------------------------------------------------
   Restart recovery, on a real restart.

   A task that was running when Nexora went down did not finish, and the
   only honest thing to do is put it back in the queue and pick it up
   again — in the same execution scope, so everything it already did
   stays protected by the side-effect guard.

   This test cannot borrow the developer's server, because it has to kill
   it. It starts its own instance on a throwaway data directory, stops it
   the way production stops (SIGTERM), starts it again, and looks at what
   came back.

   Usage: node scripts/test-restart.mjs [port]
   ------------------------------------------------------------------ */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.argv[2] || 3277);
const BASE = `http://127.0.0.1:${PORT}`;
const USER = "restart-test";
const PASS = "restart-test-pw";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-restart-"));
const results = [];
let cookie = "";
let server = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}
async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}

/**
 * Next refuses to run a second dev server out of the same directory, and the
 * developer's own server must survive this test — so the app is mirrored into
 * a scratch directory that shares the installed dependencies.
 */
// it lives inside the repository so that Node finds the installed packages by
// walking up, which a symlinked node_modules cannot do under Turbopack
const APP = path.join(process.cwd(), ".nexora-restart-sandbox");
function mirror() {
  const root = process.cwd();
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  for (const f of ["package.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "eslint.config.mjs", "next-env.d.ts"]) {
    if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(APP, f));
  }
  for (const d of ["src", "public", "scripts"]) fs.cpSync(path.join(root, d), path.join(APP, d), { recursive: true });
}

function start() {
  const child = spawn(path.join(process.cwd(), "node_modules/.bin/next"), ["dev", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: APP,
    env: { ...process.env, NEXORA_DATA_DIR: DATA, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => { if (process.env.VERBOSE) process.stdout.write(`[srv] ${b}`); });
  child.stderr.on("data", (b) => { if (process.env.VERBOSE) process.stdout.write(`[srv!] ${b}`); });
  return child;
}

async function waitUp(ms = 120_000) {
  for (let i = 0; i < ms / 500; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/me`);
      if (r.status === 200 || r.status === 401) return true;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error("the test server never came up");
}

async function signIn() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
}

/** SIGTERM, the way systemd stops the service — then wait for the port to go quiet. */
async function stop(child) {
  child.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode) break;
    await sleep(500);
  }
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/api/auth/me`); } catch { return; }
    await sleep(500);
  }
}

try {
  spawnSync(process.execPath, ["scripts/set-user.mjs", USER, PASS], { env: { ...process.env, NEXORA_DATA_DIR: DATA }, stdio: "inherit" });
  mirror();
  console.log(`data dir: ${DATA}\napp copy: ${APP}\nstarting the test instance on ${PORT} …`);
  server = start();
  await waitUp();
  await signIn();

  // a runtime that cannot answer: this test is about the machinery, not a model
  const conns = (await api("/api/providers")).connections;
  const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
  const boss = (await api("/api/agents", { name: "Restart Manager", role: "Manager", dept: "engineering", toolPermissions: [], runtime })).agent;
  const kai = (await api("/api/agents", { name: "Restart Worker", role: "Engineer", dept: "engineering", toolPermissions: [], runtime })).agent;
  await api(`/api/agents/${kai.id}`, { managerAgentId: boss.id }, "PATCH");

  const objective = (await api("/api/tasks", { title: "Objective waiting on its team", description: "Delegated out, and waiting, when the process dies.", assignedToAgentId: boss.id })).task;
  const running = (await api("/api/tasks", { title: "Interrupted by a restart", description: "This work is in flight when the process dies.", assignedToAgentId: kai.id })).task;
  const finished = (await api("/api/tasks", { title: "Already finished", description: "Nothing may bring this back.", assignedToAgentId: kai.id })).task;
  const cancelled = (await api("/api/tasks", { title: "Already cancelled", description: "Nothing may bring this back either.", assignedToAgentId: kai.id })).task;

  const waitFor = async (id, pred, ms = 20_000) => {
    for (let i = 0; i < ms / 300; i++) { const t = (await api(`/api/tasks/${id}`)).task; if (pred(t)) return t; await sleep(300); }
    return (await api(`/api/tasks/${id}`)).task;
  };
  await waitFor(objective.id, (t) => t.status === "IN_PROGRESS");
  const piece = JSON.parse((await api("/api/tools/run", { agentId: boss.id, tool: "work__create_task", args: { title: "Delegated piece across a restart", description: "Still out with the team when the process dies.", assigned_to: kai.id }, scopeId: `task:${objective.id}` })).result);
  await waitFor(running.id, (t) => t.status === "IN_PROGRESS");
  await api(`/api/tools/run`, { agentId: kai.id, tool: "work__complete_task", args: { task_id: finished.id, summary: "Finished before the restart, with the check written down and verified." }, scopeId: `task:${finished.id}` });
  await api(`/api/tasks/${cancelled.id}`, { cancel: { reason: "not wanted" } }, "PATCH");
  // put the interrupted one back in flight — completing the others freed the agent
  await waitFor(running.id, (t) => t.status === "IN_PROGRESS");
  const beforeScope = (await api(`/api/tasks/${running.id}`)).task.chatId;

  const snapshot = {
    running: (await api(`/api/tasks/${running.id}`)).task.status,
    finished: (await api(`/api/tasks/${finished.id}`)).task.status,
    cancelled: (await api(`/api/tasks/${cancelled.id}`)).task.status,
  };
  assert(snapshot.running === "IN_PROGRESS", `the interrupted task was ${snapshot.running} before the restart`);
  assert(snapshot.finished === "DONE" && snapshot.cancelled === "CANCELLED", JSON.stringify(snapshot));

  console.log("\nstopping the instance (SIGTERM) …");
  await stop(server);
  console.log("starting it again …");
  server = start();
  await waitUp();
  await signIn();
  // recovery re-dispatches a few seconds after boot, on purpose
  await sleep(9_000);

  await test("Y - work that was running at the restart is picked up again", async () => {
    const t = (await api(`/api/tasks/${running.id}`)).task;
    const history = (await api(`/api/tasks/${running.id}`)).history;
    assert(history.some((e) => e.kind === "recovered"), "nothing was recorded about the interruption");
    assert(["TODO", "IN_PROGRESS"].includes(t.status), `it came back as ${t.status}`);
    assert(t.chatId === beforeScope || t.status === "IN_PROGRESS", "the work lost its conversation");
    return `${t.status}, with the interruption recorded`;
  });

  await test("Z - a restart does not resurrect finished or cancelled work", async () => {
    const done = (await api(`/api/tasks/${finished.id}`)).task;
    const gone = (await api(`/api/tasks/${cancelled.id}`)).task;
    assert(done.status === "DONE", `finished work came back as ${done.status}`);
    assert(gone.status === "CANCELLED", `cancelled work came back as ${gone.status}`);
    const starts = (await api(`/api/tasks/${finished.id}`)).history.filter((e) => e.kind === "started").length;
    assert(starts <= 1, `${starts} start events on finished work`);
    return "DONE stayed DONE, CANCELLED stayed CANCELLED";
  });

  await test("AB - an objective waiting on its team comes back still waiting, not finished", async () => {
    const top = (await api(`/api/tasks/${objective.id}`)).task;
    const child = (await api(`/api/tasks/${piece.task_id}`)).task;
    assert(child.parentTaskId === objective.id, `the delegation link was lost: ${child.parentTaskId}`);
    assert(top.children.some((c) => c.id === piece.task_id), "the objective lost sight of its delegated work");
    assert(top.status !== "DONE", `the objective came back as ${top.status}`);
    assert(["TODO", "IN_PROGRESS", "BLOCKED"].includes(child.status), `the delegated piece came back as ${child.status}`);
    // and it still cannot be finished while that piece is open
    const early = await api("/api/tools/run", { agentId: boss.id, tool: "work__complete_task", args: { task_id: objective.id, summary: "Calling this done even though the delegated piece is still out there." }, scopeId: `task:${objective.id}` });
    assert(!early.ok && /not yet|delegated/i.test(early.error ?? ""), `the restart lost the delegation guard: ${early.error}`);
    return `objective ${top.status}, piece ${child.status}, guard intact`;
  });

  await test("AA - the interrupted work keeps its own execution scope", async () => {
    const t = (await api(`/api/tasks/${running.id}`)).task;
    const db = JSON.parse(fs.readFileSync(path.join(DATA, "nexora.json"), "utf8"));
    const conv = db.conversations.find((c) => c.chatId === t.chatId);
    assert(conv, "the task has no conversation on disk");
    assert(conv.executionScopeId === `task:${running.id}`, `scope drifted to ${conv.executionScopeId}`);
    return conv.executionScopeId;
  });
} catch (err) {
  console.log(`FAIL harness - ${err.message}`);
  results.push(false);
} finally {
  if (server) await stop(server).catch(() => undefined);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(APP, { recursive: true, force: true });
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
