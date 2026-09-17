#!/usr/bin/env node
/* ------------------------------------------------------------------
   Delegated work: CEO → managers → employees.

   One objective, handed down and reported back up. What has to hold:

     - a piece of work knows the objective it belongs to, without anyone
       being asked to say so;
     - handing work out is never the same as delivering it;
     - the person who delegated hears each result in their own objective's
       conversation, once, and burns no model time while waiting;
     - dropping an objective drops what was delegated out of it;
     - nothing late, stale or repeated can reopen settled work.

   Every agent here runs on a runtime that cannot answer, so what is being
   tested is the machinery and not a model's judgement.

   Usage: node scripts/test-delegation.mjs [baseUrl] [--keep]
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
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""} ${j.detail ?? ""}`);
  return j;
}
const run = (agentId, tool, args, scopeId, chatId) => api("/api/tools/run", { agentId, tool, args, scopeId, chatId });
const parse = (r) => { try { return JSON.parse(r.result); } catch { return {}; } };
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 400)}`); }
}
const taskOf = async (id) => (await api(`/api/tasks/${id}`)).task;
const historyOf = async (id) => (await api(`/api/tasks/${id}`)).history;
const waitFor = async (id, pred, ms = 15_000) => {
  for (let i = 0; i < ms / 300; i++) { const t = await taskOf(id); if (pred(t)) return t; await sleep(300); }
  return taskOf(id);
};
const msgs = async (agentId, chatId) => (await api(`/api/agents/${agentId}/messages?chat=${chatId}`)).messages;
const waitSystem = async (agentId, chatId, re, ms = 15_000) => {
  for (let i = 0; i < ms / 400; i++) {
    const m = (await msgs(agentId, chatId)).filter((x) => x.origin === "system" && re.test(x.content ?? ""));
    if (m.length) return m;
    await sleep(400);
  }
  return [];
};

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const conns = (await api("/api/providers")).connections;
const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
const mk = async (name, role) => (await api("/api/agents", { name, role, dept: "engineering", toolPermissions: [], runtime })).agent;

const ceo = await mk("Deleg Test CEO", "Chief Executive");
const eng = await mk("Deleg Test Eng Manager", "Engineering Manager");
const mkt = await mk("Deleg Test Marketing Manager", "Marketing Manager");
const dev = await mk("Deleg Test Engineer", "Backend Engineer");
const writer = await mk("Deleg Test Writer", "Content Agent");
const outsider = await mk("Deleg Test Outsider", "Unrelated");
for (const [a, m] of [[eng, ceo], [mkt, ceo], [dev, eng], [writer, mkt]]) await api(`/api/agents/${a.id}`, { managerAgentId: m.id }, "PATCH");

const created = [];
const newTask = async (title, description, to) => {
  const t = (await api("/api/tasks", { title, description, assignedToAgentId: to })).task;
  created.push(t.id);
  return t;
};

let root, childEng, childMkt, grandchild;

try {
  await test("A - work delegated while carrying out a task belongs to that task", async () => {
    root = await newTask("Prepare the product introduction", "Review the site and prepare an introduction and three post drafts.", ceo.id);
    const started = await waitFor(root.id, (t) => t.status === "IN_PROGRESS");
    assert(started.chatId, "the objective has no conversation");
    // the CEO delegates from inside its own objective — and says nothing about parents
    const a = parse(await run(ceo.id, "work__create_task", { title: "Review website readiness", description: "Read-only review of the live site.", assigned_to: eng.id }, `task:${root.id}`));
    const b = parse(await run(ceo.id, "work__create_task", { title: "Prepare introduction content", description: "Write the introduction and three post drafts.", assigned_to: mkt.id }, `task:${root.id}`));
    childEng = a.task_id; childMkt = b.task_id;
    created.push(childEng, childMkt);
    assert(a.part_of_task === root.id && b.part_of_task === root.id, JSON.stringify([a.part_of_task, b.part_of_task]));
    assert(/do not complete it/i.test(a.your_task ?? ""), "the CEO was not told its own task is still open");
    const view = await taskOf(root.id);
    assert(view.children.length === 2, `${view.children.length} children`);
    assert((await taskOf(childEng)).parent?.id === root.id, "the child does not point back at the objective");
    // one more level down, from the manager's own task
    await waitFor(childEng, (t) => t.status === "IN_PROGRESS");
    const g = parse(await run(eng.id, "work__create_task", { title: "Inspect the signup flow", description: "Walk the signup flow and note what is broken.", assigned_to: dev.id }, `task:${childEng}`));
    grandchild = g.task_id;
    created.push(grandchild);
    assert(g.part_of_task === childEng, JSON.stringify(g));
    return `${root.id.slice(0, 8)} → 2 children → 1 grandchild, nobody had to say so`;
  });

  await test("B - a loop in the tree is refused", async () => {
    const bad = await run(ceo.id, "work__update_task", { task_id: root.id, parent_task_id: childEng }, `task:${root.id}`);
    assert(!bad.ok, "an objective was allowed under its own child");
    assert(/underneath itself|cannot be a child/i.test(bad.error), bad.error);
    const self = await run(ceo.id, "work__update_task", { task_id: root.id, parent_task_id: root.id }, `task:${root.id}`);
    assert(!self.ok && /itself/i.test(self.error), self.error);
    assert(!(await taskOf(root.id)).parentTaskId, "the objective grew a parent anyway");
    return "self-parenting and cycles both refused";
  });

  await test("C - delegating is not delivering: the objective cannot be finished early", async () => {
    const early = await run(ceo.id, "work__complete_task", {
      task_id: root.id,
      summary: "Handed the website review to engineering and the content to marketing, so this is done.",
    }, `task:${root.id}`);
    assert(!early.ok, "an objective was completed on the strength of having delegated it");
    assert(/not yet|delegated/i.test(early.error), early.error);
    assert(/Review website readiness/.test(early.error), `the refusal does not say what is outstanding: ${early.error}`);
    const t = await taskOf(root.id);
    assert(t.status === "IN_PROGRESS" && !t.completedAt, `status ${t.status}`);
    return early.error.slice(0, 90);
  });

  await test("D - waiting for the team costs nothing and is visible as waiting", async () => {
    const t = await taskOf(root.id);
    assert(t.waitingForTeam, "the objective does not read as waiting for its team");
    assert(t.status === "IN_PROGRESS", t.status);
    // nothing of the CEO's own is running, and the dispatcher leaves it alone
    const team = (await api(`/api/tasks`)).workload.find((m) => m.agentId === ceo.id);
    assert(team, "the CEO is not in the workload list");
    const startsBefore = (await historyOf(root.id)).filter((e) => e.kind === "started").length;
    await run(ceo.id, "work__list_my_tasks", {}, `task:${root.id}`);
    await sleep(1_200);
    assert((await historyOf(root.id)).filter((e) => e.kind === "started").length === startsBefore, "the waiting objective was dispatched again");
    return `waiting for team, ${startsBefore} start event`;
  });

  await test("E - a child's result wakes the person holding the objective, in that objective's own thread", async () => {
    const parent = await taskOf(root.id);
    const before = (await msgs(ceo.id, parent.chatId)).length;
    await waitFor(childMkt, (t) => t.status === "IN_PROGRESS");
    const done = await run(mkt.id, "work__complete_task", {
      task_id: childMkt,
      summary: "Wrote the introduction and three post drafts, and checked every claim against the company profile.",
      result: { drafts: 3 },
    }, `task:${childMkt}`);
    assert(done.ok, done.error);
    const told = await waitSystem(ceo.id, parent.chatId, /Work you delegated is finished/);
    assert(told.length, "the objective's holder was never told");
    const text = told.at(-1).content;
    assert(text.includes(root.id) && text.includes(childMkt), "the wake-up does not name both the objective and the piece");
    assert(/Still out with the team/.test(text), "the wake-up does not say what is still outstanding");
    const conv = store().conversations.find((c) => c.chatId === parent.chatId);
    assert(conv.executionScopeId === `task:${root.id}`, `the objective's scope drifted to ${conv.executionScopeId}`);
    assert((await msgs(ceo.id, parent.chatId)).length > before, "nothing was delivered");
    return "delivered into the objective, scope unchanged";
  });

  await test("F - several results landing together are one wake-up, not three", async () => {
    const parent = await taskOf(root.id);
    const before = (await msgs(ceo.id, parent.chatId)).filter((m) => m.origin === "system").length;
    // two pieces of work under the objective finish within the same moment
    const x = parse(await run(ceo.id, "work__create_task", { title: "Check the pricing page", description: "Read-only check.", assigned_to: eng.id }, `task:${root.id}`));
    const y = parse(await run(ceo.id, "work__create_task", { title: "Check the docs page", description: "Read-only check.", assigned_to: mkt.id }, `task:${root.id}`));
    created.push(x.task_id, y.task_id);
    await waitFor(x.task_id, (t) => t.status === "IN_PROGRESS");
    await waitFor(y.task_id, (t) => t.status === "IN_PROGRESS");
    await Promise.all([
      run(eng.id, "work__complete_task", { task_id: x.task_id, summary: "Read the pricing page and confirmed every plan renders with a price." }, `task:${x.task_id}`),
      run(mkt.id, "work__complete_task", { task_id: y.task_id, summary: "Read the docs landing page and confirmed the three main links resolve." }, `task:${y.task_id}`),
    ]);
    await sleep(4_000);
    const after = (await msgs(ceo.id, parent.chatId)).filter((m) => m.origin === "system");
    const fresh = after.slice(before);
    assert(fresh.length >= 1, "neither result was delivered");
    assert(fresh.length === 1, `${fresh.length} separate wake-ups for two results arriving together`);
    assert(fresh[0].content.includes(x.task_id) && fresh[0].content.includes(y.task_id), "the merged wake-up lost one of the results");
    assert(/2 updates/.test(fresh[0].content), "the merged wake-up does not say how many results it carries");
    return "two results, one turn";
  });

  await test("G - a blocked piece does not stop the pieces around it", async () => {
    await waitFor(grandchild, (t) => t.status === "IN_PROGRESS");
    const b = await run(dev.id, "work__block_task", { task_id: grandchild, reason: "The signup flow needs a test account that only the vendor can create." }, `task:${grandchild}`);
    assert(b.ok, b.error);
    assert((await taskOf(grandchild)).status === "BLOCKED", "the block did not take");
    // its own manager hears about it, inside the manager's objective
    const engTask = await taskOf(childEng);
    const told = await waitSystem(eng.id, engTask.chatId, /Work you delegated is blocked/);
    assert(told.length, "the manager holding that objective was not told");
    // and everything else carries on
    assert((await taskOf(childMkt)).status === "DONE", "the marketing work was affected by an unrelated blocker");
    assert((await taskOf(root.id)).status === "IN_PROGRESS", "the whole objective stopped for one blocked piece");
    return "blocked piece reported, the rest untouched";
  });

  await test("H - an unresolved piece still blocks the objective above it", async () => {
    const early = await run(eng.id, "work__complete_task", { task_id: childEng, summary: "Reviewed what I could of the site and consider the review finished." }, `task:${childEng}`);
    assert(!early.ok && /not yet|delegated/i.test(early.error), `a blocked child did not stop its parent: ${early.error}`);
    assert(/Inspect the signup flow/.test(early.error), early.error);
    return "BLOCKED counts as unresolved, not as delivered";
  });

  await test("I - a piece that is cancelled is recorded as not delivered", async () => {
    const c = await run(eng.id, "work__cancel_task", { task_id: grandchild, reason: "The vendor account will not arrive in time; dropping this check." }, `task:${childEng}`);
    assert(c.ok, c.error);
    const done = await run(eng.id, "work__complete_task", {
      task_id: childEng,
      summary: "Reviewed the live site read-only: pages load, no console errors on the main flows.",
    }, `task:${childEng}`);
    assert(done.ok, done.error);
    const t = await taskOf(childEng);
    assert(t.status === "DONE", t.status);
    const delegated = t.result?.delegated ?? [];
    assert(delegated.length === 1 && delegated[0].status === "CANCELLED", JSON.stringify(t.result));
    assert((await historyOf(childEng)).some((e) => /cancelled rather than delivered/i.test(e.text)), "the record does not show the gap");
    return "the cancelled piece is in the result, as cancelled";
  });

  await test("J - with every piece settled, the objective can finally be finished", async () => {
    const t = await taskOf(root.id);
    assert(t.children.every((c) => !["TODO", "IN_PROGRESS", "BLOCKED"].includes(c.status)), JSON.stringify(t.children.map((c) => c.status)));
    const done = await run(ceo.id, "work__complete_task", {
      task_id: root.id,
      summary: "Engineering reviewed the site and marketing produced the introduction and three drafts; nothing was published.",
      result: { drafts: 3 },
    }, `task:${root.id}`);
    assert(done.ok, done.error);
    const after = await taskOf(root.id);
    assert(after.status === "DONE" && after.completedAt, after.status);
    assert((after.result?.delegated ?? []).length === after.children.length, JSON.stringify(after.result?.delegated));
    return `DONE with ${after.children.length} delegated pieces recorded`;
  });

  await test("K - a late result cannot reopen work that is already settled", async () => {
    const late = await run(mkt.id, "work__complete_task", { task_id: childMkt, summary: "Sending my result again, some time after it was already recorded." }, `task:${childMkt}`);
    assert(!late.ok, "a finished piece accepted a second result");
    const t = await taskOf(root.id);
    assert(t.status === "DONE", `the settled objective went back to ${t.status}`);
    const reopened = await run(ceo.id, "work__update_task", { task_id: root.id, priority: "CRITICAL" }, `task:${root.id}`);
    assert(reopened.ok, reopened.error);
    assert((await taskOf(root.id)).status === "DONE", "an edit reopened finished work");
    return "settled stays settled";
  });

  await test("L - dropping an objective drops the work delegated out of it, queued or running", async () => {
    const parent = await newTask("Objective that is called off", "This is dropped while its pieces are still out.", ceo.id);
    await waitFor(parent.id, (t) => t.status === "IN_PROGRESS");
    const running = parse(await run(ceo.id, "work__create_task", { title: "Piece already running", description: "In flight when the objective is dropped.", assigned_to: eng.id }, `task:${parent.id}`));
    const queued = parse(await run(ceo.id, "work__create_task", { title: "Piece still queued", description: "Never started before the objective is dropped.", assigned_to: eng.id }, `task:${parent.id}`));
    created.push(running.task_id, queued.task_id);
    await waitFor(running.task_id, (t) => t.status === "IN_PROGRESS");
    assert((await taskOf(queued.task_id)).status === "TODO", "the queued piece started too early for this test");
    // a grandchild too, so the cascade has to go deeper than one level
    const deep = parse(await run(eng.id, "work__create_task", { title: "Piece under the piece", description: "Two levels below the dropped objective.", assigned_to: dev.id }, `task:${running.task_id}`));
    created.push(deep.task_id);

    await api(`/api/tasks/${parent.id}`, { cancel: { reason: "The owner dropped the objective." } }, "PATCH");
    await sleep(1_500);
    for (const id of [parent.id, running.task_id, queued.task_id, deep.task_id]) {
      assert((await taskOf(id)).status === "CANCELLED", `${(await taskOf(id)).title} came back as ${(await taskOf(id)).status}`);
    }
    assert((await historyOf(queued.task_id)).some((e) => e.kind === "cancelled" && /called off/.test(e.text)), "the reason was not recorded on the piece");
    await sleep(1_500);
    assert((await taskOf(queued.task_id)).status === "CANCELLED", "a cancelled piece was picked up again");
    return "objective, its pieces and their pieces, all stopped";
  });

  await test("M - a manager cannot hang work under an objective outside its team", async () => {
    const mine = await newTask("Outsider's own work", "Nothing to do with the test company tree.", outsider.id);
    await waitFor(mine.id, (t) => t.status === "IN_PROGRESS");
    const grab = await run(eng.id, "work__update_task", { task_id: childEng, parent_task_id: mine.id }, `task:${childEng}`);
    assert(!grab.ok && /outside your team/i.test(grab.error), grab.error);
    const reach = await run(outsider.id, "work__get_task", { task_id: root.id }, `task:${mine.id}`);
    assert(!reach.ok, "an unrelated agent could read someone else's objective");
    return "delegation respects the org, not just the task ids";
  });

  await test("N - the objective's own conversation is where the outcome is reported", async () => {
    // a manager asked in a specific thread reports back into THAT thread
    const chat = (await api(`/api/agents/${mkt.id}/chats`, { title: "Owner asks here" })).chat;
    const made = parse(await run(mkt.id, "work__create_task", { title: "Small errand", description: "One small thing, asked for in a particular conversation.", assigned_to: writer.id }, `chat:${chat.id}:probe`, chat.id));
    created.push(made.task_id);
    assert(store().tasks.find((t) => t.id === made.task_id)?.originChatId === chat.id, "the task did not remember where it was asked for");
    await waitFor(made.task_id, (t) => t.status === "IN_PROGRESS");
    await run(writer.id, "work__complete_task", { task_id: made.task_id, summary: "Did the small errand and checked the result reads correctly." }, `task:${made.task_id}`);
    const told = await waitSystem(mkt.id, chat.id, new RegExp(made.task_id));
    assert(told.length, "the outcome did not come back to the conversation it was asked for in");
    return `reported into “${chat.title}”`;
  });

  await test("P - a wait inside a delegated piece leaves the objective alone", async () => {
    const parent = await newTask("Objective with a waiting piece", "One piece of this parks on a missing tool.", ceo.id);
    await waitFor(parent.id, (t) => t.status === "IN_PROGRESS");
    const piece = parse(await run(ceo.id, "work__create_task", { title: "Piece that needs a tool", description: "Needs something Nexora has not got yet.", assigned_to: eng.id }, `task:${parent.id}`));
    created.push(piece.task_id);
    await waitFor(piece.task_id, (t) => t.status === "IN_PROGRESS");
    const ask = await run(eng.id, "nexora__request_capability", {
      capability: "Vendor analytics export",
      reason: "The delegated piece needs the vendor's analytics export and no tool for it exists.",
      team_checked: true,
      team_finding: "My only report is a backend engineer with no vendor access.",
    }, `task:${piece.task_id}`);
    assert(ask.ok, ask.error);
    const req = store().capabilityRequests.filter((x) => x.requesterAgentId === eng.id).at(-1);
    assert(req.executionScopeId === `task:${piece.task_id}`, `the request carried scope ${req.executionScopeId}`);
    // the piece waits; the objective above it neither moves nor is woken
    assert((await taskOf(piece.task_id)).status === "IN_PROGRESS", "the waiting piece changed status");
    const top = await taskOf(parent.id);
    assert(top.status === "IN_PROGRESS", top.status);
    // the only system message in the objective's thread is the brief that
    // started it — nothing about a tool being obtained two levels down
    const noise = (await msgs(ceo.id, top.chatId)).filter((m) => m.origin === "system" && (/Work you delegated/.test(m.content ?? "") || (m.content ?? "").includes(req.id)));
    assert(!noise.length, "getting a tool woke the management level above it");
    const conv = store().conversations.find((c) => c.chatId === top.chatId);
    assert(conv.executionScopeId === `task:${parent.id}`, `the objective's scope drifted to ${conv.executionScopeId}`);
    await api(`/api/tasks/${parent.id}`, { cancel: { reason: "delegation suite cleanup" } }, "PATCH");
    return "the piece waits, the objective is not disturbed";
  });

  await test("Q - being the CEO grants no access of its own", async () => {
    // the top of the org chart has exactly the permissions the owner gave it
    for (const [tool, args] of [
      ["credentials__list_credentials", {}],
      ["payments__list_payment_methods", {}],
      ["capability_manager__list_agent_tool_grants", { agent: eng.id }],
    ]) {
      const r = await run(ceo.id, tool, args, `task:${root.id}`).catch((e) => ({ ok: false, error: String(e.message) }));
      assert(!r.ok, `the CEO could call ${tool} without being granted it`);
      assert(/not permitted|unknown tool|not allowed|only the capability manager/i.test(r.error ?? ""), `${tool}: ${r.error}`);
    }
    // and it cannot reach into a team that does not report to it
    const grab = await run(ceo.id, "work__assign_task", { task_id: root.id, assigned_to: dev.id }, `task:${root.id}`);
    assert(!grab.ok && /direct reports/i.test(grab.error), grab.error);
    return "management hierarchy is not a permission";
  });

  await test("O - the whole tree survives on disk exactly as the UI shows it", async () => {
    const db = store();
    const row = db.tasks.find((t) => t.id === childMkt);
    assert(row.parentTaskId === root.id, `on disk the parent is ${row.parentTaskId}`);
    const view = await taskOf(root.id);
    assert(view.children.length === db.tasks.filter((t) => t.parentTaskId === root.id).length, "the view and the file disagree about the tree");
    assert(db.tasks.every((t) => t.parentTaskId !== t.id), "a task parents itself on disk");
    return `${db.tasks.filter((t) => t.parentTaskId).length} delegated tasks recorded`;
  });
} finally {
  if (!KEEP) {
    for (const id of created.filter(Boolean)) await api(`/api/tasks/${id}`, { cancel: { reason: "delegation suite cleanup" } }, "PATCH").catch(() => undefined);
    for (const a of [ceo, eng, mkt, dev, writer, outsider]) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
  }
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
