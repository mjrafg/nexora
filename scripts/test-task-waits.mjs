#!/usr/bin/env node
/* ------------------------------------------------------------------
   Waiting, inside a task.

   A task is not finished when the agent stops — it is finished when the
   outcome is reached. Between those two points the work parks: for a tool
   it has not got, for a login, for the owner's decision on money. Every
   one of those has to come back to the SAME task, in the SAME execution
   scope, in the SAME conversation, with the original instructions intact
   — and exactly once.

   Nothing here spends real money: the merchant is Nexora's own mock
   checkout page and every row it writes says so.

   Usage: node scripts/test-task-waits.mjs [baseUrl] [--keep]
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
const MERCHANT = "Nexora Mock Checkout (test data)";
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
const msgsIn = async (agentId, chatId) => (await api(`/api/agents/${agentId}/messages?chat=${chatId}`)).messages;
/** Did the manager actually hear about it — in any of its threads? */
const waitTold = async (agentId, taskId, ms = 25_000) => {
  for (let i = 0; i < ms / 500; i++) {
    const chats = (await api(`/api/agents/${agentId}/chats`)).chats ?? [];
    for (const c of chats) {
      const m = (await msgsIn(agentId, c.id)).find((x) => x.origin === "system" && (x.content ?? "").includes(taskId));
      if (m) return m;
    }
    await sleep(500);
  }
  return null;
};
const waitMsg = async (agentId, chatId, re, ms = 20_000) => {
  for (let i = 0; i < ms / 400; i++) {
    const m = (await msgsIn(agentId, chatId)).find((x) => x.origin === "system" && re.test(x.content ?? ""));
    if (m) return m;
    await sleep(400);
  }
  return null;
};

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const conns = (await api("/api/providers")).connections;
const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
const mk = async (name, role, perms) => (await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, runtime })).agent;

const boss = await mk("Waits Test Manager", "Engineering Manager", []);
const worker = await mk("Waits Test Worker", "Engineer", ["browser", "payments", "payments_use"]);
await api(`/api/agents/${worker.id}`, { managerAgentId: boss.id }, "PATCH");
const capMgr = (await api("/api/agents")).agents.find((a) => a.system === "capability-manager");

const settings = (await api("/api/payments/settings")).settings;
const created = { tasks: [], methods: [] };

try {
  /* ============================================================ capability */

  await test("1 - a capability wait keeps the task, its scope and its thread", async () => {
    const r = await run(boss.id, "work__create_task", { title: "Export the vendor invoices", description: "Pull the invoice list from the vendor system and summarise it.", assigned_to: worker.id });
    const id = parse(r).task_id;
    created.tasks.push(id);
    const started = await waitFor(id, (t) => t.status === "IN_PROGRESS");
    const startsBefore = (await historyOf(id)).filter((e) => e.kind === "started").length;

    const ask = await run(worker.id, "nexora__request_capability", {
      capability: "Vendor invoice export API access",
      reason: "The task needs the vendor's invoice API and no tool for it exists.",
      context: `Task ${id}`,
    }, `task:${id}`);
    assert(ask.ok, ask.error);

    const req = store().capabilityRequests.filter((x) => x.requesterAgentId === worker.id).at(-1);
    assert(req, "no capability request was recorded");
    assert(req.executionScopeId === `task:${id}`, `the request carried scope ${req.executionScopeId}`);
    const parked = (await api(`/api/agents/${worker.id}`)).agent;
    assert(parked.waiting?.kind === "capability", JSON.stringify(parked.waiting));
    // waiting on Nexora is not a blocker, and it is not a new piece of work
    const t = await taskOf(id);
    assert(t.status === "IN_PROGRESS", `the task became ${t.status} while waiting for a tool`);
    assert((await api("/api/tasks")).tasks.filter((x) => x.assignedTo?.id === worker.id && x.status !== "CANCELLED").length === 1, "a replacement task appeared");
    assert((await historyOf(id)).filter((e) => e.kind === "started").length === startsBefore, "the task was started again while it waited");
    return `${req.id.slice(0, 8)} parked in scope task:${id.slice(0, 8)} (thread ${started.chatId.slice(0, 8)})`;
  });

  let capTask;
  await test("2 - resolving the capability resumes the SAME task, once, with the work intact", async () => {
    capTask = created.tasks.at(-1);
    const task = await taskOf(capTask);
    const req = store().capabilityRequests.filter((x) => x.requesterAgentId === worker.id).at(-1);
    // the Capability Manager finishes the request through its own tool
    const res = await run(capMgr.id, "capability_manager__resolve_request", {
      request: req.id,
      summary: "Registered the vendor invoice export capability and granted it to the requester.",
      granted: ["vendor_invoices__list"],
    }, `caprequest:${req.id}`);
    assert(res.ok, res.error);

    const resumed = await waitMsg(worker.id, task.chatId, /RESOLVED|resolved|capability/i);
    assert(resumed, "the agent was never resumed in the task thread");
    const conv = store().conversations.find((c) => c.chatId === task.chatId);
    assert(conv.executionScopeId === `task:${capTask}`, `scope drifted to ${conv.executionScopeId}`);
    assert(!(await api(`/api/agents/${worker.id}`)).agent.waiting, "still parked after the capability arrived");
    const threads = (await api(`/api/agents/${worker.id}/chats`)).chats.filter((c) => c.title === "Export the vendor invoices");
    assert(threads.length === 1, `${threads.length} threads for one task — the resume started a second run`);
    assert((await historyOf(capTask)).filter((e) => e.kind === "started").length === 1, "the task was started twice");
    // the original instruction is still in the thread the agent came back to
    const brief = (await msgsIn(worker.id, task.chatId)).find((m) => (m.content ?? "").includes("Pull the invoice list"));
    assert(brief, "the original instructions were lost");
    return "resumed in place, scope and instructions intact";
  });

  await test("3 - the work then completes and the manager is told", async () => {
    const done = await run(worker.id, "work__complete_task", {
      task_id: capTask,
      summary: "Exported the invoice list through the capability that was granted and checked the totals against the vendor page.",
      result: { invoices: 12 },
    }, `task:${capTask}`);
    assert(done.ok, done.error);
    assert((await taskOf(capTask)).status === "DONE", "the task did not finish");
    const told = await waitTold(boss.id, capTask);
    assert(told, "the manager was never told");
    return "manager woken with the result";
  });

  await test("4 - a capability that cannot be had comes back as an honest blocker, not a lie", async () => {
    const r = await run(boss.id, "work__create_task", { title: "Post to the vendor forum", description: "Publish the release note on the vendor forum.", assigned_to: worker.id });
    const id = parse(r).task_id;
    created.tasks.push(id);
    const task = await waitFor(id, (t) => t.status === "IN_PROGRESS");
    await run(worker.id, "nexora__request_capability", { capability: "Vendor forum posting account", reason: "No account exists for the vendor forum.", context: `Task ${id}` }, `task:${id}`);
    const req = store().capabilityRequests.filter((x) => x.requesterAgentId === worker.id).at(-1);
    const failed = await run(capMgr.id, "capability_manager__fail_request", { request: req.id, reason: "The vendor forum requires a human-verified account that Nexora cannot create." }, `caprequest:${req.id}`);
    assert(failed.ok, failed.error);
    const resumed = await waitMsg(worker.id, task.chatId, /FAILED|could not|cannot/i);
    assert(resumed, "the agent was not resumed after the failure");
    assert((await taskOf(id)).status === "IN_PROGRESS", "a failed capability silently killed the task");
    const blocked = await run(worker.id, "work__block_task", { task_id: id, reason: "The vendor forum needs a human-verified account; the Capability Manager could not create one." }, `task:${id}`);
    assert(blocked.ok, blocked.error);
    assert((await taskOf(id)).status === "BLOCKED", "the blocker did not take");
    return "failed capability → honest blocker, task intact";
  });

  /* ============================================================ payment */

  await api("/api/payments/settings", { autoApproveLimit: 5 }, "PUT").catch(async () => { await api("/api/payments/settings", { autoApproveLimit: 5 }); });
  const card = (await api("/api/payments/methods", {
    type: "CARD", displayName: "Waits Test Card (test data)",
    description: "Test card used by the task-waits regression suite against Nexora's own mock checkout. Not a real payment instrument.",
    cardholderName: "Nexora Test", cardNumber: "4111 1111 1111 1111", expirationMonth: 8, expirationYear: 2029, cvv: "123",
    billing: { line1: "1 Test St", city: "Austin", region: "TX", postalCode: "78701", country: "US" },
  })).method;
  created.methods.push(card.id);

  let payTask, payReq;
  await test("5 - a payment above the threshold parks the task on the owner, without bypassing anything", async () => {
    const r = await run(boss.id, "work__create_task", { title: "Buy the mock subscription", description: `Complete a checkout at ${MERCHANT} for the test plan.`, assigned_to: worker.id });
    payTask = parse(r).task_id;
    created.tasks.push(payTask);
    await waitFor(payTask, (t) => t.status === "IN_PROGRESS");
    const p = parse(await run(worker.id, "payments__request_payment", { merchant: MERCHANT, amount: 20, reason: "Test plan at Nexora's own mock checkout — synthetic data only.", billing_type: "ONE_TIME" }, `task:${payTask}`));
    assert(p.status === "WAITING_FOR_APPROVAL", JSON.stringify(p));
    payReq = p.payment_request_id;
    const req = (await api(`/api/payments/requests/${payReq}`)).request;
    assert(req.executionScopeId === `task:${payTask}`, `the payment carried scope ${req.executionScopeId}`);
    const parked = (await api(`/api/agents/${worker.id}`)).agent;
    assert(parked.waiting?.kind === "payment", JSON.stringify(parked.waiting));
    assert((await taskOf(payTask)).status === "IN_PROGRESS", "the task was abandoned while waiting for approval");
    // nothing may be released before the owner decides
    const early = await run(worker.id, "payments__begin_payment", { payment_request_id: payReq }, `task:${payTask}`);
    assert(!early.ok && /waiting/i.test(early.error), early.error);
    return `#${payReq.slice(0, 8)} waiting on the owner, scope task:${payTask.slice(0, 8)}`;
  });

  await test("6 - approval resumes the same task and the checkout goes through exactly once", async () => {
    const task = await taskOf(payTask);
    const approved = (await api(`/api/payments/requests/${payReq}/approve`, { paymentMethodId: card.id, note: "test run" })).request;
    assert(approved.status === "APPROVED" && approved.approvalType === "OWNER", JSON.stringify(approved.status));
    const resumed = await waitMsg(worker.id, task.chatId, /APPROVED/);
    assert(resumed, "the agent was not resumed in the task thread after approval");
    const conv = store().conversations.find((c) => c.chatId === task.chatId);
    assert(conv.executionScopeId === `task:${payTask}`, `scope drifted to ${conv.executionScopeId}`);
    assert((await historyOf(payTask)).filter((e) => e.kind === "started").length === 1, "approval started the task a second time");

    const begin = await run(worker.id, "payments__begin_payment", { payment_request_id: payReq }, `task:${payTask}`);
    assert(begin.ok, begin.error);
    assert(!begin.result.includes("4111111111111111") && !/cvv\s*[:=]/i.test(begin.result), "secrets released to the agent");
    const nav = await run(worker.id, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, `task:${payTask}`);
    const ref = (nav.result.match(/"Card number"[^\n]*\[ref=([a-z0-9]+)\]/i) || [])[1];
    assert(ref, `card field not found: ${nav.result.slice(0, 200)}`);
    const ins = await run(worker.id, "payments__insert_payment_method_fields", { payment_method_id: card.id, payment_request_id: payReq, fields: { card_number: ref } }, `task:${payTask}`);
    assert(ins.ok && !ins.result.includes("4111111111111111"), ins.error ?? ins.result);
    const done = await run(worker.id, "payments__complete_payment", { payment_request_id: payReq, status: "SUCCEEDED", actual_amount: 20, external_reference: `TEST-${Date.now()}` }, `task:${payTask}`);
    assert(done.ok, done.error);
    // the same approval cannot be spent twice from the same scope
    const again = await run(worker.id, "payments__complete_payment", { payment_request_id: payReq, status: "SUCCEEDED", actual_amount: 20 }, `task:${payTask}`);
    assert(again.guard?.outcome === "deduplicated" || /already/i.test(again.error ?? ""), JSON.stringify({ g: again.guard, e: again.error }));
    const rows = (await api("/api/payments/history")).transactions.filter((t) => t.paymentRequestId === payReq);
    assert(rows.length === 1 && rows[0].status === "SUCCEEDED", JSON.stringify(rows.map((r) => r.status)));
    assert(rows[0].merchant === MERCHANT && /test/i.test(rows[0].merchant), "the history row does not identify itself as test data");
    assert(!JSON.stringify(rows).includes("4111111111111111"), "history leaks the card number");
    return `one SUCCEEDED row, method •••• ${rows[0].paymentMethodLast4}`;
  });

  await test("7 - the finished payment task reports upward with no secrets in the report", async () => {
    const done = await run(worker.id, "work__complete_task", {
      task_id: payTask,
      summary: `Completed the ${MERCHANT} checkout for $20.00 with the approved card ending 1111 and verified the confirmation page.`,
      result: { payment_request: payReq, amount: 20 },
    }, `task:${payTask}`);
    assert(done.ok, done.error);
    const t = await taskOf(payTask);
    assert(t.status === "DONE", t.status);
    const blob = JSON.stringify({ t, history: await historyOf(payTask) });
    assert(!blob.includes("4111111111111111") && !/\bcvv\b/i.test(blob), "the task record carries payment secrets");
    const told = await waitTold(boss.id, payTask);
    assert(told, "the manager was never told the payment task finished");
    assert(!told.content.includes("4111111111111111"), "the manager notification carries the card number");
    return "reported upward, clean";
  });

  await test("8 - a rejected payment does not stop the task, and is not simply asked again", async () => {
    const r = await run(boss.id, "work__create_task", { title: "Buy the rejected mock plan", description: `Try to buy the premium test plan at ${MERCHANT}.`, assigned_to: worker.id });
    const id = parse(r).task_id;
    created.tasks.push(id);
    const task = await waitFor(id, (t) => t.status === "IN_PROGRESS");
    const scope = `task:${id}`;
    const ask = { merchant: MERCHANT, amount: 29, reason: "Premium test plan at Nexora's own mock checkout — synthetic data only.", billing_type: "ONE_TIME" };
    const p = parse(await run(worker.id, "payments__request_payment", ask, scope));
    assert(p.status === "WAITING_FOR_APPROVAL", JSON.stringify(p));
    const rejected = (await api(`/api/payments/requests/${p.payment_request_id}/reject`, { note: "not this month" })).request;
    assert(rejected.status === "REJECTED", rejected.status);
    const resumed = await waitMsg(worker.id, task.chatId, /REJECTED/);
    assert(resumed, "the agent was not told about the rejection in its task thread");
    assert(/do not request this payment again/i.test(resumed.content), "the rejection message does not tell the agent to stop asking");
    assert(!(await api(`/api/agents/${worker.id}`)).agent.waiting, "still parked after the rejection");
    assert((await taskOf(id)).status === "IN_PROGRESS", "a rejection silently killed the task");
    // no money may be released, and the identical request in the same scope is refused
    const begin = await run(worker.id, "payments__begin_payment", { payment_request_id: p.payment_request_id }, scope);
    assert(!begin.ok && /rejected/i.test(begin.error), begin.error);
    const repeat = await run(worker.id, "payments__request_payment", ask, scope);
    assert(repeat.guard?.outcome === "deduplicated" || repeat.guard?.outcome === "in_flight_reused", `the identical rejected request was recreated: ${JSON.stringify(repeat.guard)}`);
    const rows = (await api("/api/payments/history")).transactions.filter((t) => t.paymentRequestId === p.payment_request_id);
    assert(rows.length === 1 && rows[0].status === "REJECTED", JSON.stringify(rows.map((x) => x.status)));
    // and the refused repeat left no second request behind in this task's scope
    const inScope = store().paymentRequests.filter((x) => x.executionScopeId === scope);
    assert(inScope.length === 1, `${inScope.length} payment requests in one task scope — the rejected one was asked again`);
    // the honest outcome goes up to the manager
    const blocked = await run(worker.id, "work__block_task", { task_id: id, reason: "The owner rejected the $29.00 premium plan and there is no free tier that covers it." }, scope);
    assert(blocked.ok, blocked.error);
    const told = await waitTold(boss.id, id);
    assert(told, "the manager was never told the work stopped on a rejected payment");
    return "rejected once, not re-asked, reported honestly";
  });
} finally {
  if (!KEEP) {
    await api("/api/payments/settings", { autoApproveLimit: settings.autoApproveLimit }).catch(() => undefined);
    for (const id of created.tasks) await api(`/api/tasks/${id}`, { cancel: { reason: "task-waits suite cleanup" } }, "PATCH").catch(() => undefined);
    for (const id of created.methods) await api(`/api/payments/methods/${id}`, null, "DELETE").catch(() => undefined);
    for (const a of [boss, worker]) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
  }
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
