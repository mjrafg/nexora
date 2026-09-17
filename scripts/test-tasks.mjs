#!/usr/bin/env node
/* ------------------------------------------------------------------
   Manager → employee → task.

   Covers the loop the management layer exists for: a manager sees its
   team, creates work, the employee is woken without being told to start,
   the work completes or blocks honestly, the manager hears about it, and
   the execution scope stays the task's own from the first wake to the
   last — which is what keeps the side-effect guard protecting it.

   Usage: node scripts/test-tasks.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}


const BASE = process.argv[2] || "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const USER = process.env.NEXORA_USER || "mjrafg";
const PASS = requirePassword();
const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data");
let cookie = "";

async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""} ${j.detail ?? ""}`);
  return j;
}
const run = (agentId, tool, args, scopeId) => api("/api/tools/run", { agentId, tool, args, scopeId });
const parse = (r) => { try { return JSON.parse(r.result); } catch { return {}; } };
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 400)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const taskOf = async (id) => (await api(`/api/tasks/${id}`)).task;
const waitFor = async (id, pred, ms = 12_000) => {
  for (let i = 0; i < ms / 300; i++) { const t = await taskOf(id); if (pred(t)) return t; await sleep(300); }
  return taskOf(id);
};

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

// a runtime that fails immediately: these tests drive the task machinery through
// its tools and its API, never through a model's judgement
const conns = (await api("/api/providers").catch(() => ({ connections: [] }))).connections ?? [];
const dead = conns.find((c) => c.status !== "connected") ?? conns[0];
const runtime = dead ? { runtimeType: "api", providerConnectionId: dead.id, model: "test-model-does-not-exist" } : undefined;
const mk = async (name, role) => (await api("/api/agents", { name, role, dept: "engineering", toolPermissions: [], runtime })).agent;

const boss = await mk("Task Test CTO", "Chief Technology Officer");
const kai = await mk("Task Test Backend", "Backend Engineer");
const mia = await mk("Task Test Frontend", "Frontend Engineer");
const outsider = await mk("Task Test Outsider", "Nobody's report");
const created = [];
const fresh = []; // agents a single test needed on its own
const createdLogins = [];
const tmpDirs = [];

try {
  await test("A - an agent reports to a manager, and the manager gains a team", async () => {
    await api(`/api/agents/${kai.id}`, { managerAgentId: boss.id }, "PATCH");
    await api(`/api/agents/${mia.id}`, { managerAgentId: boss.id }, "PATCH");
    const view = (await api(`/api/agents/${boss.id}`)).agent;
    assert(view.reports.length === 2, `${view.reports.length} reports`);
    const report = (await api(`/api/agents/${kai.id}`)).agent;
    assert(report.manager?.id === boss.id, JSON.stringify(report.manager));
    return `${view.reports.map((r) => r.name).join(", ")} report to ${view.name}`;
  });

  await test("B - a reporting loop is refused", async () => {
    let refused = false;
    try { await api(`/api/agents/${boss.id}`, { managerAgentId: kai.id }, "PATCH"); } catch { refused = true; }
    assert(refused, "a manager was allowed to report to its own report");
    let self = false;
    try { await api(`/api/agents/${kai.id}`, { managerAgentId: kai.id }, "PATCH"); } catch { self = true; }
    assert(self, "an agent was allowed to report to itself");
  });

  await test("C - list_team gives the manager roles, status and workload", async () => {
    const r = await run(boss.id, "work__list_team", {});
    assert(r.ok, r.error);
    const { team } = parse(r);
    assert(team.length === 2, JSON.stringify(team));
    const one = team.find((m) => m.agent_id === kai.id);
    assert(one && one.role === "Backend Engineer", JSON.stringify(one));
    assert(one.status === "IDLE" && one.active_tasks === 0 && one.pending_tasks === 0, JSON.stringify(one));
    return `${team.length} reports, with role, status and counts`;
  });

  await test("D - an employee has no management tools", async () => {
    const r = await run(kai.id, "work__list_team", {});
    assert(!r.ok, "a non-manager could call list_team");
    const mine = await run(kai.id, "work__list_my_tasks", {});
    assert(mine.ok, mine.error);
  });

  let first;
  await test("E - the manager creates work and the employee starts without being told", async () => {
    const r = await run(boss.id, "work__create_task", {
      title: "Investigate the database API error",
      description: "Find why the database API returns 500s on write and fix it. Verify with a real write.",
      assigned_to: kai.id,
      priority: "HIGH",
    });
    assert(r.ok, r.error);
    first = parse(r).task_id;
    created.push(first);
    const t = await waitFor(first, (x) => x.status === "IN_PROGRESS" || x.startedAt);
    assert(t.assignedToAgentId === kai.id, JSON.stringify(t.assignedTo));
    assert(t.priority === "HIGH", t.priority);
    assert(t.managerAgentId === boss.id, "the manager is not recorded as accountable");
    assert(t.status === "IN_PROGRESS", `status is ${t.status} — nobody woke the agent`);
    assert(t.startedAt, "no start time recorded");
    assert(t.chatId, "the work got no conversation of its own");
    return `${t.status}, started automatically`;
  });

  await test("F - the work runs in its own execution scope, task:<id>", async () => {
    const chatId = (await taskOf(first)).chatId;
    const convs = store().conversations.filter((c) => c.chatId === chatId);
    assert(convs.length === 1, `${convs.length} conversations for the task thread`);
    assert(convs[0].executionScopeId === `task:${first}`, `scope is ${convs[0].executionScopeId}`);
    return convs[0].executionScopeId;
  });

  await test("G - the side-effect guard protects the task across a resume", async () => {
    const scope = `task:${first}`;
    const args = { title: "Guard probe", description: "A probe task used to prove the guard sees the task scope.", assigned_to: kai.id };
    const a = await run(boss.id, "work__create_task", args, scope);
    assert(a.ok, a.error);
    created.push(parse(a).task_id);
    // the same call again in the same task scope — as would happen after a
    // capability wait woke the agent and it retried
    const b = await run(boss.id, "work__create_task", args, scope);
    const dup = b.guard?.outcome === "deduplicated" || b.guard?.outcome === "in_flight_reused";
    assert(dup, `second identical call was not deduplicated: ${JSON.stringify(b.guard)}`);
    const mine = new Set(created);
    const rows = store().tasks.filter((t) => t.title === "Guard probe" && mine.has(t.id));
    assert(rows.length === 1, `${rows.length} probe tasks from this run — the guard let a duplicate through`);
    return b.guard.outcome;
  });

  await test("H - the employee completes with a real result and the manager is told", async () => {
    const before = (await api(`/api/agents/${boss.id}/messages`)).messages.length;
    const r = await run(kai.id, "work__complete_task", {
      task_id: first,
      summary: "Found the write path rejecting null tenant ids, fixed the guard clause and verified a real write end to end.",
      result: { tests: "18/18 passed", files_changed: ["src/db/write.ts"] },
    }, `task:${first}`);
    assert(r.ok, r.error);
    const t = await taskOf(first);
    assert(t.status === "DONE", t.status);
    assert(t.resultSummary?.includes("guard clause"), t.resultSummary);
    assert(t.result?.tests === "18/18 passed", JSON.stringify(t.result));
    assert(t.completedAt, "no completion time");
    // the manager hears about it as an event, without polling
    for (let i = 0; i < 30; i++) {
      const msgs = (await api(`/api/agents/${boss.id}/messages`)).messages;
      if (msgs.length > before && msgs.some((m) => m.origin === "system" && /finished/i.test(m.content) && m.content.includes(first))) return "manager woken with the result";
      await sleep(400);
    }
    throw new Error("the manager was never told the task finished");
  });

  await test("I - a thin result is refused: DONE must mean something", async () => {
    const r = await run(boss.id, "work__create_task", { title: "Thin result probe", description: "Probe.", assigned_to: mia.id });
    const id = parse(r).task_id;
    created.push(id);
    await waitFor(id, (t) => t.status === "IN_PROGRESS");
    const bad = await run(mia.id, "work__complete_task", { task_id: id, summary: "done" }, `task:${id}`);
    assert(!bad.ok, "a one-word summary was accepted as a result");
    assert(/what you achieved/i.test(bad.error), bad.error);
    const t = await taskOf(id);
    assert(t.status === "IN_PROGRESS", `status moved to ${t.status} on a refused completion`);
    await run(mia.id, "work__cancel_task", { task_id: id, reason: "probe finished" }, `task:${id}`).catch(() => undefined);
  });

  let blocked;
  await test("J - a genuine blocker blocks the task and wakes the manager", async () => {
    const r = await run(boss.id, "work__create_task", { title: "Deploy to staging", description: "Deploy the current build to staging and verify it serves.", assigned_to: kai.id, priority: "NORMAL" });
    blocked = parse(r).task_id;
    created.push(blocked);
    await waitFor(blocked, (t) => t.status === "IN_PROGRESS");
    const thin = await run(kai.id, "work__block_task", { task_id: blocked, reason: "stuck" }, `task:${blocked}`);
    assert(!thin.ok, "a vague blocker was accepted");
    const before = (await api(`/api/agents/${boss.id}/messages`)).messages.length;
    const ok = await run(kai.id, "work__block_task", {
      task_id: blocked,
      reason: "Staging deploys need the Cloudflare account, which Nexora has no access to and the Capability Manager could not obtain.",
    }, `task:${blocked}`);
    assert(ok.ok, ok.error);
    const t = await taskOf(blocked);
    assert(t.status === "BLOCKED" && t.blockedReason.includes("Cloudflare"), JSON.stringify(t.status));
    for (let i = 0; i < 30; i++) {
      const msgs = (await api(`/api/agents/${boss.id}/messages`)).messages;
      if (msgs.length > before && msgs.some((m) => m.origin === "system" && /blocked/i.test(m.content) && m.content.includes(blocked))) return "manager woken with the blocker and the history";
      await sleep(400);
    }
    throw new Error("the manager was never told the task blocked");
  });

  await test("K - reassignment moves the work and keeps every trace of it", async () => {
    const r = await run(boss.id, "work__reassign_task", { task_id: blocked, assigned_to: mia.id, reason: "Kai is on the production incident." });
    assert(r.ok, r.error);
    const t = await waitFor(blocked, (x) => x.assignedToAgentId === mia.id);
    assert(t.assignedToAgentId === mia.id, JSON.stringify(t.assignedTo));
    const { history } = await api(`/api/tasks/${blocked}`);
    assert(history.some((e) => e.kind === "blocked" && /Cloudflare/.test(e.text)), "the block reason was lost");
    assert(history.some((e) => e.kind === "reassigned" && /production incident/.test(e.text)), "the reason for the move was not recorded");
    const kaiTasks = (await api(`/api/tasks?agent=${kai.id}`)).tasks;
    assert(!kaiTasks.some((x) => x.id === blocked), "the previous holder still has it");
    return "history intact, previous holder released";
  });

  await test("L - a manager may not hand work outside its own team", async () => {
    const r = await run(boss.id, "work__create_task", { title: "Outside the team", description: "Should be refused.", assigned_to: outsider.id });
    assert(!r.ok, "a manager assigned work to someone who does not report to it");
    assert(/direct reports/i.test(r.error), r.error);
    const mine = await run(kai.id, "work__complete_task", { task_id: blocked, summary: "Not mine to finish, but trying anyway." }, `task:${blocked}`);
    assert(!mine.ok, "an employee completed a task that is not theirs");
  });

  await test("M - priority decides what an idle agent picks up first", async () => {
    const queueAgent = await mk("Task Test Queue", "Engineer");
    fresh.push(queueAgent);
    // queue three while the agent is occupied, then let it go
    const hold = await api("/api/tasks", { title: "Occupy the agent", description: "Holds the slot.", assignedToAgentId: queueAgent.id, priority: "NORMAL" });
    created.push(hold.task.id);
    await waitFor(hold.task.id, (t) => t.status === "IN_PROGRESS");
    const low = await api("/api/tasks", { title: "Tidy the README", description: "Low value.", assignedToAgentId: queueAgent.id, priority: "LOW" });
    const crit = await api("/api/tasks", { title: "Production is down", description: "Highest urgency.", assignedToAgentId: queueAgent.id, priority: "CRITICAL" });
    const normal = await api("/api/tasks", { title: "Answer the vendor", description: "Middling.", assignedToAgentId: queueAgent.id, priority: "NORMAL" });
    created.push(low.task.id, crit.task.id, normal.task.id);
    assert((await taskOf(crit.task.id)).status === "TODO", "a queued task started while the agent was busy");
    // release the agent: the critical one must be next, not the oldest
    await api(`/api/tasks/${hold.task.id}`, { cancel: { reason: "probe over" } }, "PATCH");
    const started = await waitFor(crit.task.id, (t) => t.status === "IN_PROGRESS");
    assert(started.status === "IN_PROGRESS", `the critical task is ${started.status}`);
    assert((await taskOf(low.task.id)).status === "TODO", "the low-priority task jumped the queue");
    return "CRITICAL ran before NORMAL and LOW";
  });

  await test("N - cancelling stops the work and it never restarts", async () => {
    const t = (await api("/api/tasks", { title: "Cancel probe", description: "Will be cancelled.", assignedToAgentId: kai.id })).task;
    created.push(t.id);
    await waitFor(t.id, (x) => x.status === "IN_PROGRESS");
    await api(`/api/tasks/${t.id}`, { cancel: { reason: "no longer needed" } }, "PATCH");
    const c = await taskOf(t.id);
    assert(c.status === "CANCELLED", c.status);
    await sleep(2500);
    assert((await taskOf(t.id)).status === "CANCELLED", "a cancelled task came back to life");
    const { history } = await api(`/api/tasks/${t.id}`);
    assert(history.some((e) => e.kind === "cancelled" && /no longer needed/.test(e.text)), "the reason was not recorded");
  });

  await test("O - the owner can drive work directly, without a manager", async () => {
    const solo = await mk("Task Test Solo", "Analyst");
    fresh.push(solo);
    const t = (await api("/api/tasks", { title: "Owner's own task", description: "Straight from the owner.", assignedToAgentId: solo.id, priority: "HIGH" })).task;
    created.push(t.id);
    assert(t.createdByOwner === true, "not recorded as the owner's");
    const started = await waitFor(t.id, (x) => x.status === "IN_PROGRESS");
    assert(started.status === "IN_PROGRESS", started.status);
    await api(`/api/tasks/${t.id}`, { priority: "CRITICAL" }, "PATCH");
    assert((await taskOf(t.id)).priority === "CRITICAL", "priority did not change");
    const { history } = await api(`/api/tasks/${t.id}`);
    assert(history.some((e) => e.kind === "priority"), "the priority change was not recorded");
  });

  await test("P - every task survives on disk exactly as the UI shows it", async () => {
    const db = store();
    for (const id of created.filter(Boolean)) {
      const onDisk = db.tasks.find((t) => t.id === id);
      if (!onDisk) continue;
      const live = await taskOf(id);
      assert(onDisk.status === live.status, `${id}: disk ${onDisk.status} vs api ${live.status}`);
    }
    const events = db.taskEvents.filter((e) => created.includes(e.taskId));
    assert(events.length >= created.length, "task history is not being persisted");
    return `${created.length} tasks and ${events.length} history rows on disk`;
  });

  await test("R - a credential wait inside a task resumes into the same task, same scope", async () => {
    const worker = await mk("Task Test Credentials", "Integrations Engineer");
    fresh.push(worker);
    await api(`/api/agents/${worker.id}`, { toolPermissions: ["credentials"] }, "PATCH");
    const t = (await api("/api/tasks", { title: "Connect the vendor portal", description: "Log in to the vendor portal and export the invoice list.", assignedToAgentId: worker.id })).task;
    created.push(t.id);
    const started = await waitFor(t.id, (x) => x.status === "IN_PROGRESS");
    assert(started.chatId, "the task has no conversation");
    // the agent asks for a login it does not have, inside the task's own scope
    const ask = await run(worker.id, "credentials__request_credential", {
      service: "Vendor Portal", site: "vendor.example", login_url: "https://vendor.example/login",
      reason: "The invoice export needs the vendor portal login and none is stored.",
    }, `task:${t.id}`);
    assert(ask.ok, ask.error);
    const parked = (await api(`/api/agents/${worker.id}`)).agent;
    assert(parked.waiting?.kind === "credential", JSON.stringify(parked.waiting));
    // the work is waiting on Nexora, not blocked on a human outside it
    assert((await taskOf(t.id)).status === "IN_PROGRESS", "a credential wait wrongly marked the task BLOCKED");
    // the owner supplies it; the agent must come back to THIS task
    const req = (await api("/api/logins")).requests.find((x) => x.id === parked.waiting.requestId);
    assert(req.executionScopeId === `task:${t.id}`, `the request kept scope ${req.executionScopeId}`);
    const cred = (await api("/api/logins", {
      name: `Vendor Portal — task test ${Date.now()}`, service: "Vendor Portal", site: "vendor.example",
      description: "Vendor portal login created by the task regression suite to prove a resume lands in the same task.",
      username: "tester@example.com", password: `pw-${Math.random().toString(36).slice(2)}`, requestId: req.id,
    })).credential;
    createdLogins.push(cred.id);
    for (let i = 0; i < 40; i++) {
      const msgs = (await api(`/api/agents/${worker.id}/messages?chat=${started.chatId}`)).messages;
      if (msgs.some((m) => m.origin === "system" && /Vendor Portal/i.test(m.content))) {
        const conv = store().conversations.find((c) => c.chatId === started.chatId);
        assert(conv.executionScopeId === `task:${t.id}`, `scope drifted to ${conv.executionScopeId}`);
        assert(!(await api(`/api/agents/${worker.id}`)).agent.waiting, "still parked after the credential arrived");
        return "resumed in the task thread, scope unchanged";
      }
      await sleep(500);
    }
    throw new Error("the agent never resumed on its task after the credential was supplied");
  });

  await test("S - work can be pinned to a folder, and the folder is validated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-task-"));
    tmpDirs.push(dir);
    // a path that is not absolute, or does not exist, is refused rather than stored
    for (const bad of ["not/absolute", path.join(dir, "does-not-exist")]) {
      let refused = false;
      try { await api("/api/tasks", { title: "Folder probe", description: "Probe.", workingDirectory: bad }); } catch { refused = true; }
      assert(refused, `a bad folder was accepted: ${bad}`);
    }
    const worker = await mk("Task Test Folder", "Engineer");
    fresh.push(worker);
    const t = (await api("/api/tasks", { title: "Work in a real folder", description: "Do the work in the folder this task is pinned to.", assignedToAgentId: worker.id, workingDirectory: dir })).task;
    created.push(t.id);
    assert(t.workingDirectory === fs.realpathSync(dir) || t.workingDirectory === dir, `stored ${t.workingDirectory}`);
    const started = await waitFor(t.id, (x) => x.status === "IN_PROGRESS");
    // the agent is told where it is working, in the same message that starts it
    const msgs = (await api(`/api/agents/${worker.id}/messages?chat=${started.chatId}`)).messages;
    const brief = msgs.find((m) => m.origin === "system");
    assert(brief && brief.content.includes(t.workingDirectory), `the brief does not name the folder: ${brief?.content?.slice(0, 200)}`);
    return t.workingDirectory;
  });

  await test("T - the folder can be created from Nexora and survives a reassignment", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-parent-"));
    tmpDirs.push(parent);
    const made = (await api("/api/fs", { parent, name: "new task folder!" })).created;
    assert(made.name === "new-task-folder-", `sanitised to ${made.name}`);
    assert(fs.existsSync(made.path) && fs.statSync(made.path).isDirectory(), "the folder was not created on disk");
    let dup = false;
    try { await api("/api/fs", { parent, name: made.name }); } catch { dup = true; }
    assert(dup, "creating the same folder twice was allowed");
    const t = (await api("/api/tasks", { title: "Folder follows the work", description: "Reassigning must not lose the folder.", assignedToAgentId: kai.id, workingDirectory: made.path })).task;
    created.push(t.id);
    await waitFor(t.id, (x) => x.status === "IN_PROGRESS");
    // an idle report, so the move starts immediately rather than queueing
    const taker = await mk("Task Test Folder Taker", "Engineer");
    fresh.push(taker);
    await api(`/api/agents/${taker.id}`, { managerAgentId: boss.id }, "PATCH");
    await run(boss.id, "work__reassign_task", { task_id: t.id, assigned_to: taker.id, reason: "They have the context." });
    // the new holder gets a fresh thread of their own; wait for it to exist
    const after = await waitFor(t.id, (x) => x.assignedToAgentId === taker.id && !!x.chatId);
    assert(after.workingDirectory === made.path, `the folder was lost on reassignment: ${after.workingDirectory}`);
    const msgs = (await api(`/api/agents/${taker.id}/messages?chat=${after.chatId}`)).messages;
    assert(msgs.some((m) => m.origin === "system" && m.content.includes(made.path)), "the new holder was not told the folder");
    return made.path;
  });

  await test("U - two wake events for the same task start it exactly once", async () => {
    const worker = await mk("Task Test Double Wake", "Engineer");
    fresh.push(worker);
    await api(`/api/agents/${worker.id}`, { managerAgentId: boss.id }, "PATCH");
    const r = await run(boss.id, "work__create_task", { title: "Start me once", description: "Two events arrive together; exactly one run may come of it.", assigned_to: worker.id });
    const id = parse(r).task_id;
    created.push(id);
    await waitFor(id, (t) => t.status === "IN_PROGRESS");
    const before = (await api(`/api/tasks/${id}`)).history.filter((e) => e.kind === "started").length;
    // the same wake arriving three ways at once: a re-assignment to the same
    // person, a manual start, and the dispatcher being asked again
    await Promise.all([
      run(boss.id, "work__assign_task", { task_id: id, assigned_to: worker.id }).catch(() => undefined),
      run(worker.id, "work__start_task", { task_id: id }, `task:${id}`).catch(() => undefined),
      run(boss.id, "work__assign_task", { task_id: id, assigned_to: worker.id }).catch(() => undefined),
    ]);
    await sleep(1_200);
    const t = await taskOf(id);
    const starts = (await api(`/api/tasks/${id}`)).history.filter((e) => e.kind === "started").length;
    assert(starts === before, `${starts} start events after ${before} — a duplicate wake started the work again`);
    const chats = (await api(`/api/agents/${worker.id}/chats`)).chats;
    assert(chats.filter((c) => c.title === "Start me once").length === 1, `${chats.length} threads for one task`);
    assert(t.status === "IN_PROGRESS", t.status);
    return `one start, one thread, ${starts} started event(s)`;
  });

  await test("V - cancelling while the agent is parked ends the work for good", async () => {
    const worker = await mk("Task Test Cancel Wait", "Integrations Engineer");
    fresh.push(worker);
    await api(`/api/agents/${worker.id}`, { toolPermissions: ["credentials"], managerAgentId: boss.id }, "PATCH");
    const t = (await api("/api/tasks", { title: "Cancelled mid-wait", description: "This work is cancelled while its agent is parked on a login request.", assignedToAgentId: worker.id })).task;
    created.push(t.id);
    const started = await waitFor(t.id, (x) => x.status === "IN_PROGRESS");
    const ask = await run(worker.id, "credentials__request_credential", {
      service: "Cancel Probe Portal", site: "cancel-probe.example", login_url: "https://cancel-probe.example/login",
      reason: "The task needs a login for the cancel-probe portal and none is stored.",
    }, `task:${t.id}`);
    assert(ask.ok, ask.error);
    assert((await api(`/api/agents/${worker.id}`)).agent.waiting?.kind === "credential", "the agent never parked");
    // the manager gives up on it while it is parked
    const c = await run(boss.id, "work__cancel_task", { task_id: t.id, reason: "No longer needed." });
    assert(c.ok, c.error);
    assert((await taskOf(t.id)).status === "CANCELLED", "cancel did not take");
    // the login turns up anyway: the agent may be resumed, the task may not
    const req = (await api("/api/logins")).requests.find((x) => x.executionScopeId === `task:${t.id}`);
    if (req) {
      const cred = (await api("/api/logins", {
        name: `Cancel Probe — task test ${Date.now()}`, service: "Cancel Probe Portal", site: "cancel-probe.example",
        description: "Created by the task regression suite to prove a cancelled task does not restart when its login arrives.",
        username: "tester@example.com", password: `pw-${Math.random().toString(36).slice(2)}`, requestId: req.id,
      })).credential;
      createdLogins.push(cred.id);
    }
    await sleep(2_500);
    const after = await taskOf(t.id);
    assert(after.status === "CANCELLED", `a cancelled task came back as ${after.status}`);
    const starts = (await api(`/api/tasks/${t.id}`)).history.filter((e) => e.kind === "started").length;
    assert(starts === 1, `${starts} start events — the cancelled task was picked up again`);
    return `still CANCELLED after the login arrived (chat ${started.chatId.slice(0, 8)})`;
  });

  await test("W - finished and cancelled work is never restarted", async () => {
    const worker = await mk("Task Test Finished", "Engineer");
    fresh.push(worker);
    await api(`/api/agents/${worker.id}`, { managerAgentId: boss.id }, "PATCH");
    const r = await run(boss.id, "work__create_task", { title: "Finish me once", description: "Once this is done it stays done, whatever arrives afterwards.", assigned_to: worker.id });
    const id = parse(r).task_id;
    created.push(id);
    await waitFor(id, (t) => t.status === "IN_PROGRESS");
    await run(worker.id, "work__complete_task", { task_id: id, summary: "Checked the queue, wrote the note and verified it reads back correctly." }, `task:${id}`);
    assert((await taskOf(id)).status === "DONE", "it did not finish");
    // every route back into execution has to refuse
    const again = await run(worker.id, "work__start_task", { task_id: id }, `task:${id}`);
    assert(!again.ok, "a finished task could be started again");
    await run(boss.id, "work__assign_task", { task_id: id, assigned_to: worker.id }).catch(() => undefined);
    await sleep(1_000);
    const t = await taskOf(id);
    assert(t.status === "DONE" && t.completedAt, `status ${t.status}`);
    assert((await api(`/api/tasks/${id}`)).history.filter((e) => e.kind === "started").length === 1, "it was started a second time");
    return "DONE survived a start, an assign and a dispatch";
  });

  await test("X - a worker whose task moved on cannot finish it", async () => {
    const worker = await mk("Task Test Stale", "Engineer");
    const taker = await mk("Task Test Stale Taker", "Engineer");
    fresh.push(worker, taker);
    await api(`/api/agents/${worker.id}`, { managerAgentId: boss.id }, "PATCH");
    await api(`/api/agents/${taker.id}`, { managerAgentId: boss.id }, "PATCH");
    const r = await run(boss.id, "work__create_task", { title: "Moved out from under them", description: "The first holder keeps working after it has been taken away.", assigned_to: worker.id });
    const id = parse(r).task_id;
    created.push(id);
    await waitFor(id, (t) => t.status === "IN_PROGRESS");
    await run(boss.id, "work__reassign_task", { task_id: id, assigned_to: taker.id, reason: "Closer to the problem." });
    await waitFor(id, (t) => t.assignedToAgentId === taker.id);
    // the old holder comes back with a result nobody asked for any more
    const stale = await run(worker.id, "work__complete_task", { task_id: id, summary: "Finished the thing I was working on before it was taken away from me." }, `task:${id}`);
    assert(!stale.ok, "a stale worker was allowed to finish someone else's task");
    // the tool layer refuses first ("not assigned to you"); the service refuses
    // again underneath it, so a direct call cannot get past either
    assert(/not assigned to you|no longer yours/i.test(stale.error), stale.error);
    const staleBlock = await run(worker.id, "work__block_task", { task_id: id, reason: "I could not continue with the work that is no longer assigned to me." }, `task:${id}`);
    assert(!staleBlock.ok, "a stale worker was allowed to block someone else's task");
    const t = await taskOf(id);
    assert(t.status !== "DONE" && t.status !== "BLOCKED", `the stale result landed anyway: ${t.status}`);
    assert(t.assignedToAgentId === taker.id, "ownership changed");
    return `refused: ${stale.error.slice(0, 60)}`;
  });

  await test("AB - a manager must look at its team before asking Nexora for a tool", async () => {
    const first = await run(boss.id, "nexora__request_capability", {
      capability: "Vendor invoice export API",
      reason: "The report the owner asked for needs the vendor invoice API.",
    }, `chat:probe:${Date.now()}`);
    assert(!first.ok, "a manager got a capability without looking at its team");
    assert(/list_team|direct report/i.test(first.error), first.error);
    // having looked, the manager may still decide nobody can do it
    const second = await run(boss.id, "nexora__request_capability", {
      capability: "Vendor invoice export API",
      reason: "The report the owner asked for needs the vendor invoice API.",
      team_checked: true,
      team_finding: "Both reports are engineers with no vendor access; neither can reach the vendor system.",
    }, `chat:probe2:${Date.now()}`);
    assert(second.ok, second.error);
    const req = store().capabilityRequests.filter((x) => x.requesterAgentId === boss.id).at(-1);
    assert(req && /Team checked first/.test(req.context ?? ""), "what the manager found was not recorded on the request");
    // an employee is not slowed down by this at all
    const emp = await run(mia.id, "nexora__request_capability", {
      capability: "Vendor invoice export API",
      reason: "The task needs the vendor invoice API and no tool for it exists.",
    }, `chat:probe3:${Date.now()}`);
    assert(emp.ok, emp.error);
    return "manager redirected to its team once, then allowed; employee unaffected";
  });

  await test("Q - work is not a project session: the Director's world is untouched", async () => {
    const db = store();
    assert(Array.isArray(db.projectSessions), "project sessions disappeared");
    assert(db.tasks.every((t) => !("milestoneId" in t) && !("sessionId" in t)), "a task grew project fields");
    const projects = await api("/api/projects").catch(() => null);
    assert(projects, "the projects API stopped answering");
  });
} finally {
  if (!KEEP) {
    // cancel what this run created, then remove its agents
    for (const id of created.filter(Boolean)) await api(`/api/tasks/${id}`, { cancel: { reason: "regression suite cleanup" } }, "PATCH").catch(() => undefined);
    for (const id of createdLogins) await api(`/api/logins/${id}`, null, "DELETE").catch(() => undefined);
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    for (const a of [boss, kai, mia, outsider, ...fresh]) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
