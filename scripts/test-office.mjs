#!/usr/bin/env node
/* ------------------------------------------------------------------
   The office is a view of Nexora, not a story about it.

   What has to be true of the floor the picture is drawn from:

     - every avatar is a real agent, with its real id, in the real
       department it belongs to, exactly once however much work it holds;
     - "working" means a model is running right now, and nothing else —
       a task sitting at IN_PROGRESS is not the same thing;
     - a wait says what is being waited for and where to resolve it;
     - hiring, renaming, moving and removing an agent change the floor;
     - a department with nobody in it is shown as empty, not hidden.

   Usage: node scripts/test-office.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
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
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}
const run = (agentId, tool, args, scopeId) => api("/api/tools/run", { agentId, tool, args, scopeId });
const parse = (r) => { try { return JSON.parse(r.result); } catch { return {}; } };
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}
const floor = () => api("/api/office");
const find = (f, id) => [...f.departments.flatMap((d) => d.agents), ...f.unassigned].find((a) => a.id === id);
const waitState = async (id, pred, ms = 12_000) => {
  for (let i = 0; i < ms / 400; i++) { const a = find(await floor(), id); if (a && pred(a)) return a; await sleep(400); }
  return find(await floor(), id);
};

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const conns = (await api("/api/providers")).connections;
const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
const mk = async (name, role, dept, perms = []) => (await api("/api/agents", { name, role, dept, toolPermissions: perms, runtime })).agent;

const boss = await mk("Office Test Lead", "Engineering Manager", "engineering");
const dev = await mk("Office Test Engineer", "Backend Engineer", "engineering");
const ops = await mk("Office Test Ops", "Operations Analyst", "operations", ["credentials"]);
await api(`/api/agents/${dev.id}`, { managerAgentId: boss.id }, "PATCH");
const created = [];
const logins = [];
const extra = [];

try {
  await test("A - the floor is the real company: real ids, real departments, everyone once", async () => {
    const f = await floor();
    const all = [...f.departments.flatMap((d) => d.agents), ...f.unassigned];
    const real = (await api("/api/agents")).agents;
    assert(all.length === real.length, `${all.length} on the floor vs ${real.length} agents`);
    assert(new Set(all.map((a) => a.id)).size === all.length, "an agent appears twice on the floor");
    for (const a of all) assert(real.some((r) => r.id === a.id && r.name === a.name && r.dept === a.dept), `${a.name} is not where the agent record says`);
    assert(f.departments.some((d) => d.id === "engineering"), "engineering is missing");
    assert(!f.departments.some((d) => d.id === "conference"), "the meeting room is listed as a department people work in");
    return `${all.length} agents across ${f.departments.length} departments`;
  });

  await test("B - a department with nobody in it is shown as empty, not hidden", async () => {
    const f = await floor();
    const all = f.departments.map((d) => `${d.name}:${d.agents.length}`);
    assert(f.departments.length >= 6, all.join(", "));
    assert(f.departments.every((d) => Array.isArray(d.agents)), "a department has no list at all");
    return all.join(" · ");
  });

  await test("C - holding a task is not the same as working", async () => {
    const t = (await api("/api/tasks", { title: "Office probe task", description: "Held, not running.", assignedToAgentId: dev.id })).task;
    created.push(t.id);
    // while the turn is genuinely running the office says WORKING, and that is
    // correct; what is being checked here is what it says once the turn ends
    // and the task is still sitting at IN_PROGRESS
    const a = await waitState(dev.id, (x) => x.state === "STALLED", 45_000);
    assert((await api(`/api/tasks/${t.id}`)).task.status === "IN_PROGRESS", "the task never started");
    assert(a.state === "STALLED", `a held-but-not-running task was shown as ${a.state}`);
    assert(a.currentTask?.id === t.id, JSON.stringify(a.currentTask));
    assert(/Office probe task/.test(a.label), a.label);
    return `${a.state} — ${a.label}`;
  });

  await test("D - a wait says what it is waiting for, and where to resolve it", async () => {
    const t = (await api("/api/tasks", { title: "Office login probe", description: "Needs a login.", assignedToAgentId: ops.id })).task;
    created.push(t.id);
    await sleep(1200);
    const ask = await run(ops.id, "credentials__request_credential", {
      service: "Office Probe Portal", site: "office-probe.example", login_url: "https://office-probe.example/login",
      reason: "The probe task needs the office probe portal login and none is stored.",
    }, `task:${t.id}`);
    assert(ask.ok, ask.error);
    const a = await waitState(ops.id, (x) => x.state === "WAITING_LOGIN");
    assert(a.state === "WAITING_LOGIN", a.state);
    assert(/Office Probe Portal/.test(a.label), a.label);
    assert(a.href && a.href.startsWith("/credentials?request="), `no way to act on it: ${a.href}`);
    return `${a.state} → ${a.href}`;
  });

  await test("E - a blocked agent shows the real reason", async () => {
    // its own agent: someone already holding work would only queue this
    const worker = await mk("Office Test Blocked", "Engineer", "engineering");
    extra.push(worker);
    const t = (await api("/api/tasks", { title: "Office block probe", description: "Will be blocked.", assignedToAgentId: worker.id })).task;
    created.push(t.id);
    const started = await waitState(worker.id, (x) => x.currentTask?.id === t.id, 20_000);
    assert(started.currentTask?.id === t.id, `the probe never reached the agent: ${JSON.stringify(started.currentTask)}`);
    await run(worker.id, "work__block_task", { task_id: t.id, reason: "The office regression suite blocked this on purpose to check the floor." }, `task:${t.id}`);
    const a = await waitState(worker.id, (x) => x.state === "BLOCKED");
    assert(a.state === "BLOCKED", a.state);
    assert(/on purpose/.test(a.label), a.label);
    return a.label.slice(0, 70);
  });

  await test("F - a manager waiting on its team reads as waiting for its team", async () => {
    const obj = (await api("/api/tasks", { title: "Office delegation probe", description: "Delegated out.", assignedToAgentId: boss.id })).task;
    created.push(obj.id);
    await sleep(1500);
    const piece = parse(await run(boss.id, "work__create_task", { title: "Office delegated piece", description: "Out with the team.", assigned_to: dev.id }, `task:${obj.id}`));
    created.push(piece.task_id);
    const a = await waitState(boss.id, (x) => x.state === "WAITING_TEAM");
    assert(a.state === "WAITING_TEAM", `expected WAITING_TEAM, got ${a.state} — ${a.label}`);
    assert(/Office delegation probe/.test(a.label), a.label);
    return a.label;
  });

  await test("G - one avatar per agent, however much work it is carrying", async () => {
    for (let i = 0; i < 3; i++) {
      const t = (await api("/api/tasks", { title: `Office load probe ${i}`, description: "More work for the same person.", assignedToAgentId: ops.id })).task;
      created.push(t.id);
    }
    await sleep(1500);
    const f = await floor();
    const mine = [...f.departments.flatMap((d) => d.agents)].filter((a) => a.id === ops.id);
    assert(mine.length === 1, `${mine.length} avatars for one agent`);
    assert(mine[0].otherOpen >= 1, `the extra work is not counted: ${mine[0].otherOpen}`);
    return `1 avatar, ${mine[0].otherOpen} more open`;
  });

  await test("H - hiring, renaming, moving and removing change the floor", async () => {
    const hire = await mk("Office Test Newcomer", "Support Specialist", "support");
    let f = await floor();
    assert(f.departments.find((d) => d.id === "support").agents.some((a) => a.id === hire.id), "a new agent did not appear");
    await api(`/api/agents/${hire.id}`, { name: "Office Test Renamed", dept: "finance" }, "PATCH");
    f = await floor();
    const moved = find(f, hire.id);
    assert(moved.name === "Office Test Renamed" && moved.dept === "finance", JSON.stringify({ n: moved.name, d: moved.dept }));
    assert(!f.departments.find((d) => d.id === "support").agents.some((a) => a.id === hire.id), "they are still at their old desk");
    await api(`/api/agents/${hire.id}`, null, "DELETE");
    f = await floor();
    assert(!find(f, hire.id), "a removed agent is still on the floor");
    return "hire → rename → move → remove, all reflected";
  });

  await test("I - the totals add up to the people who are there", async () => {
    const f = await floor();
    const all = [...f.departments.flatMap((d) => d.agents), ...f.unassigned];
    const { working, waiting, blocked, idle, agents } = f.totals;
    assert(agents === all.length, `${agents} counted vs ${all.length} present`);
    assert(working + waiting + blocked + idle === agents, `${working}+${waiting}+${blocked}+${idle} ≠ ${agents}`);
    assert(f.totals.openTasks === (await api("/api/tasks?status=open")).tasks.length, "the open-task count disagrees with Work");
    return `${agents} = ${working} working + ${waiting} waiting + ${blocked} stuck + ${idle} free`;
  });

  await test("J - the floor changes announce themselves on the existing activity stream", async () => {
    const ac = new AbortController();
    const seen = [];
    const reading = fetch(`${BASE}/api/office/events`, { headers: { cookie }, signal: ac.signal }).then(async (r) => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const text = dec.decode(value);
        for (const line of text.split("\n")) if (line.startsWith("data:")) seen.push(line.slice(5).trim());
      }
    }).catch(() => undefined);
    await sleep(800);
    const t = (await api("/api/tasks", { title: "Office event probe", description: "Should announce itself.", assignedToAgentId: ops.id })).task;
    created.push(t.id);
    for (let i = 0; i < 30 && !seen.length; i++) await sleep(300);
    ac.abort();
    await reading;
    assert(seen.length > 0, "nothing was announced when work was created");
    assert(seen.some((s) => /task:/.test(s)), seen.slice(0, 3).join(" | "));
    return `${seen.length} event(s), e.g. ${seen[0].slice(0, 60)}`;
  });

  await test("K - the floor is derived, never stored: nothing of it is on disk", async () => {
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    assert(!("office" in db) && !("floor" in db), "the office started keeping its own copy of the company");
    assert(db.agents.every((a) => !("state" in a) && !("seat" in a)), "an agent grew office-only fields");
    return "no second source of truth";
  });
} finally {
  if (!KEEP) {
    for (const id of created.filter(Boolean)) await api(`/api/tasks/${id}`, { cancel: { reason: "office suite cleanup" } }, "PATCH").catch(() => undefined);
    for (const id of logins) await api(`/api/logins/${id}`, null, "DELETE").catch(() => undefined);
    for (const a of [boss, dev, ops, ...extra]) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
  }
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
