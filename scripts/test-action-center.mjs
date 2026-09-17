#!/usr/bin/env node
/* ------------------------------------------------------------------
   Owner Action Center regression suite.

   The product promise under test: if Needs You is empty, nothing
   anywhere is waiting on a human. Everything that blocks an agent shows
   up here, resolving it here resolves the authoritative record, and the
   agent resumes the same task.

   Usage: node scripts/test-action-center.mjs [baseUrl] [--keep]
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
const run = (agentId, tool, args, scopeId) => api("/api/tools/run", { agentId, tool, args, scopeId });
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 500)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const center = () => api("/api/action-center");
const agentOf = async (id) => (await api(`/api/agents/${id}`)).agent;
const find = async (pred) => (await center()).actions.find(pred);

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const conns = (await api("/api/providers").catch(() => ({ connections: [] }))).connections ?? [];
const dead = conns.find((c) => c.status !== "connected");
const runtime = dead ? { runtimeType: "api", providerConnectionId: dead.id, model: "test-model-does-not-exist" } : undefined;
const mk = async (name, toolPermissions) => (await api("/api/agents", { name, role: "Test", dept: "engineering", toolPermissions, runtime })).agent;
const worker = await mk("Action Center Agent", ["browser", "company_profile", "company_custom_data_manage", "credentials", "payments", "payments_use"]);
const A = worker.id;
const scope = `test:ac:${Date.now()}`;
const KEY = `actioncenter${Date.now().toString().slice(-6)}`;
const created = { data: [], methods: [] };

try {
  await test("a data request appears in Needs You with a form, and blocks its agent", async () => {
    const r = await run(A, "owner__request_owner_action", {
      kind: "data", title: "Date of birth required", reason: "The signup form verifies age and nothing is stored for it.",
      fields: [{ key: `${KEY}.birth_date`, label: "Date of birth", type: "date", required: true, save_for_future: true }],
    }, scope);
    assert(r.ok && /END YOUR TURN/i.test(r.result), r.error ?? r.result);
    const a = await find((x) => x.kind === "data" && x.title === "Date of birth required");
    assert(a, "action missing from Needs You");
    assert(a.blocking && a.payload.fields?.[0]?.type === "date" && a.payload.fields[0].saveForFuture, JSON.stringify(a.payload));
    const agent = await agentOf(A);
    assert(agent.waiting?.kind === "owner_action" && agent.waiting.requestId === a.id, JSON.stringify(agent.waiting));
    assert(agent.waiting.href === `/action-center?action=${a.id}`, agent.waiting.href);
    return `#${a.id.slice(0, 8)} blocking ${agent.name}`;
  });

  await test("submitting the form saves it for future, resolves the action and resumes the agent", async () => {
    const a = await find((x) => x.title === "Date of birth required");
    const key = a.payload.fields[0].key;
    await api(`/api/action-center/${a.id}`, { values: { [key]: "1990-01-01" }, save: { [key]: true } });
    const stored = (await api("/api/company/custom-data")).data.find((d) => d.key === key);
    assert(stored && stored.value === "1990-01-01" && stored.status === "verified" && stored.valueType === "date", JSON.stringify(stored));
    created.data.push(stored.id);
    assert(!(await find((x) => x.id === a.id)), "resolved action still listed");
    assert(!(await agentOf(A)).waiting, "agent still parked");
    let msgs = [];
    for (let i = 0; i < 60; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /1990-01-01/.test(m.content))) break; await sleep(1000); }
    const resume = msgs.find((m) => m.origin === "system" && /Date of birth/.test(m.content));
    assert(resume && /1990-01-01/.test(resume.content) && /saved for future use/.test(resume.content), resume?.content?.slice(0, 200));
    assert(/continue from where you stopped/i.test(resume.content), "the resume must continue the same task");
    return "verified in company data, agent resumed with the value";
  });

  await test("a second agent uses the stored value instead of asking", async () => {
    const other = await mk("Action Center Reader", ["company_profile"]);
    try {
      const r = await run(other.id, "company__get_company_custom_data", { keys: [`${KEY}.birth_date`] }, `${scope}:reader`);
      const out = JSON.parse(r.result);
      assert(out.found?.[0]?.value === "1990-01-01" && out.found[0].status === "verified", r.result.slice(0, 200));
      assert(!(await agentOf(other.id)).waiting, "reading a stored value must not block");
      assert(!(await find((x) => x.agentId === other.id)), "no action should have been created");
    } finally { await api(`/api/agents/${other.id}`, null, "DELETE").catch(() => undefined); }
    return "found without asking the owner";
  });

  await test("a non-blocking action does not park the agent", async () => {
    const r = await run(A, "owner__request_owner_action", { kind: "decision", title: "Prefer weekly or monthly reports?", reason: "Either works; I will use weekly meanwhile.", blocking: false, choices: [{ value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }] }, scope);
    assert(r.ok && /not blocked/i.test(r.result), r.error ?? r.result);
    const a = await find((x) => x.title.startsWith("Prefer weekly"));
    assert(a && a.blocking === false, JSON.stringify(a && { blocking: a.blocking }));
    assert(!(await agentOf(A)).waiting, "a non-blocking ask parked the agent");
    await api(`/api/action-center/${a.id}`, { choice: "weekly" });
    assert(!(await find((x) => x.id === a.id)), "still listed after answering");
    return "listed, agent kept working";
  });

  await test("a payment waiting for approval appears here and approving it resolves the payment record", async () => {
    const original = (await api("/api/payments/settings")).settings;
    const m = (await api("/api/payments/methods", { type: "CARD", displayName: `Action Center Card ${Date.now()}`, description: "Card used by the action-center suite to create an above-limit approval.", cardholderName: "Nexora Test", cardNumber: "4111111111111111", expirationMonth: 8, expirationYear: 2029, cvv: "123", billing: { postalCode: "78701", country: "US" } })).method;
    created.methods.push(m.id);
    await api("/api/payments/settings", { autoApproveLimit: 1 }, "PUT");
    try {
      const p = JSON.parse((await run(A, "payments__request_payment", { merchant: "Action Vendor", amount: 47.2, reason: "Annual renewal" }, `${scope}:pay`)).result);
      const a = await find((x) => x.kind === "payment" && x.sourceRequestId === p.payment_request_id);
      assert(a, "payment not projected into Needs You");
      assert(a.sourceRequestType === "payment" && a.payload.href === `/payments/requests?request=${p.payment_request_id}`, JSON.stringify(a.payload.href));
      assert(a.payload.details.some((d) => d.value.includes("47.20")), JSON.stringify(a.payload.details));
      assert(a.payload.choices.some((c) => c.value === "approve") && a.payload.choices.some((c) => c.value === "reject"), "approve/decline missing");
      // the authoritative record is still the payment request, and Payments still owns it
      const before = (await api("/api/payments/requests")).requests.find((x) => x.id === p.payment_request_id);
      assert(before.status === "WAITING_FOR_APPROVAL", before.status);
      await api(`/api/action-center/${a.id}`, { choice: "approve" });
      const after = (await api("/api/payments/requests")).requests.find((x) => x.id === p.payment_request_id);
      assert(after.status === "APPROVED" && after.approvalType === "OWNER", JSON.stringify({ s: after.status, t: after.approvalType }));
      assert(!(await find((x) => x.id === a.id)), "approved payment still in Needs You");
      assert(!(await agentOf(A)).waiting, "agent still waiting after approval");
      await api(`/api/payments/requests/${p.payment_request_id}/cancel`, { note: "test cleanup" }).catch(() => undefined);
    } finally {
      await api("/api/payments/settings", { autoApproveLimit: original.autoApproveLimit, defaultPaymentMethodId: original.defaultPaymentMethodId }, "PUT").catch(() => undefined);
    }
    return "projected, approved here, Payments stayed authoritative";
  });

  await test("a credential request appears without Needs You taking over Credentials", async () => {
    const r = await run(A, "credentials__request_credential", { service: "Legacy Portal", site: "legacy.example", reason: "The account predates Nexora." }, `${scope}:cred`);
    assert(r.ok, r.error);
    const a = await find((x) => x.kind === "credential");
    assert(a && a.sourceRequestType === "credential" && a.payload.href.startsWith("/credentials?request="), JSON.stringify(a && a.payload));
    // passwords are never taken through the generic form
    const refused = await api(`/api/action-center/${a.id}`, { values: { password: "nope" } }).catch((e) => e);
    assert(refused instanceof Error && /Credentials page/i.test(refused.message), String(refused.message ?? refused));
    const logins = (await api("/api/logins")).requests.find((x) => x.id === a.sourceRequestId);
    assert(logins.status === "WAITING", "the credential request must stay open");
    await api(`/api/action-center/${a.id}`, { dismiss: true, note: "not needed" });
    const after = (await api("/api/logins")).requests.find((x) => x.id === a.sourceRequestId);
    assert(after.status === "CANCELLED", after.status);
    assert(!(await agentOf(A)).waiting, "dismissing left the agent parked");
    return "projection only; the record stayed in Credentials";
  });

  await test("a CAPTCHA becomes a browser takeover of the same session, and returning control resumes the task", async () => {
    await run(A, "browser__browser_navigate", { url: `${BASE}/mock-login.html` }, scope);
    const before = (await api("/api/browser/sessions")).sessions.find((s) => s.id === `agent:${A}`);
    const r = await run(A, "owner__request_owner_action", { kind: "captcha", title: "Human verification", reason: "Google is asking for a human check before the account can be created." }, scope);
    assert(r.ok && /END YOUR TURN/i.test(r.result), r.error ?? r.result);
    const a = await find((x) => x.kind === "browser" || x.kind === "captcha");
    assert(a && a.browserSessionId === `agent:${A}`, JSON.stringify(a && { s: a.browserSessionId }));
    // never a credential or capability request
    assert(!(await center()).actions.some((x) => x.kind === "credential" && x.agentId === A), "CAPTCHA produced a credential request");
    const dock = await api(`/api/agents/${A}/browser`);
    assert(dock.live && dock.control === "owner" && dock.image, JSON.stringify({ live: dock.live, control: dock.control }));
    const after = (await api("/api/browser/sessions")).sessions.find((s) => s.id === `agent:${A}`);
    assert(before.createdAt === after.createdAt, "the browser was recreated for the takeover");
    await api(`/api/action-center/${a.id}`, { choice: "returned" });
    const session = (await api("/api/browser/sessions")).sessions.find((s) => s.id === `agent:${A}`);
    assert(session.createdAt === before.createdAt, "the session did not survive the return");
    assert(!(await find((x) => x.id === a.id)), "handoff still listed");
    assert(!(await agentOf(A)).waiting, "agent still parked after control came back");
    let msgs = [];
    for (let i = 0; i < 60; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /browser_snapshot/.test(m.content))) break; await sleep(1000); }
    assert(msgs.some((m) => m.origin === "system" && /browser_snapshot/.test(m.content)), "the agent was not told to re-read the page");
    return "same BrowserContext throughout";
  });

  await test("the live viewer is same-origin and addresses the agent's own session", async () => {
    const r = await fetch(`${BASE}/browser/sessions/agent_${A}/live`, { headers: { cookie } });
    assert(r.ok, `viewer route ${r.status}`);
    const html = await r.text();
    assert(!/<iframe[^>]+accounts\.google/.test(html), "the viewer must not frame the external site");
    return "/browser/sessions/:sessionId/live serves the viewer";
  });

  await test("a turn-budget approval appears and continuing grants the task more steps", async () => {
    const r = await run(A, "owner__request_owner_action", { kind: "turn_budget", title: "Long task check", reason: "Used many steps and still working." }, scope);
    assert(r.ok, r.error);
    const a = await find((x) => x.kind === "turn_budget");
    assert(a && a.blocking, JSON.stringify(a));
    await api(`/api/action-center/${a.id}`, { choice: "continue" });
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    const grant = db.turnGrants.find((g) => g.agentId === A);
    assert(grant && grant.extra > 0, `no turn grant recorded: ${JSON.stringify(db.turnGrants)}`);
    assert(!(await agentOf(A)).waiting, "still parked after granting steps");
    return `granted ${grant.extra} steps to the same task`;
  });

  await test("notifications: one per action, deep-linked, never repeated", async () => {
    const before = (await api("/api/notifications")).notifications.length;
    const r = await run(A, "owner__request_owner_action", { kind: "approval", title: "Approve the vendor switch", reason: "Two suppliers are equivalent; you decide.", choices: [{ value: "yes", label: "Approve" }] }, scope);
    assert(r.ok, r.error);
    const a = await find((x) => x.title === "Approve the vendor switch");
    const list = (await api("/api/notifications")).notifications;
    const mine = list.filter((n) => n.actionId === a.id);
    assert(mine.length === 1, `expected one notification, got ${mine.length}`);
    assert(mine[0].href === `/action-center?action=${a.id}`, mine[0].href);
    assert(mine[0].state === "unread" && mine[0].urgency === "high", JSON.stringify(mine[0]));
    assert(!/password|secret|token/i.test(`${mine[0].title} ${mine[0].body}`), "notification text must never carry secrets");
    // re-reading the centre must not re-announce it
    await center(); await center();
    const again = (await api("/api/notifications")).notifications.filter((n) => n.actionId === a.id);
    assert(again.length === 1, `notification was repeated: ${again.length}`);
    // the API returns the newest 50, so a total-count check stops meaning
    // anything once the log is longer than that: assert the row itself is there
    assert(list.some((n) => n.id === mine[0].id), "notification not recorded");
    void before;
    await api("/api/notifications", { id: mine[0].id });
    assert((await api("/api/notifications")).notifications.find((n) => n.id === mine[0].id).state === "read", "read state not stored");
    await api(`/api/action-center/${a.id}`, { choice: "yes" });
    return "one notification, deep link, marked read";
  });

  await test("a request created inside its own domain is announced too", async () => {
    const r = await run(A, "company__request_company_info", { field: `${KEY}.vendor_code`, needed_by: "Vendor portal registration", reason: "The portal will not accept the form without it." }, `${scope}:proj`);
    assert(r.ok, r.error);
    const a = await find((x) => x.sourceRequestType === "company");
    assert(a, "company request not projected");
    // the centre announces projections as well as its own rows
    await center();
    const notif = (await api("/api/notifications")).notifications.filter((n) => n.actionId === a.id);
    assert(notif.length === 1, `expected one notification for the projection, got ${notif.length}`);
    assert(notif[0].href === `/action-center?action=${encodeURIComponent(a.id)}`, notif[0].href);
    await center(); await center();
    assert((await api("/api/notifications")).notifications.filter((n) => n.actionId === a.id).length === 1, "projection notification repeated");
    await api(`/api/action-center/${a.id}`, { values: { [a.payload.fields[0].key]: "VC-9912" }, save: { [a.payload.fields[0].key]: true } });
    const stored = (await api("/api/company/custom-data")).data.find((d) => d.key === `${KEY}.vendor_code`);
    assert(stored && stored.value === "VC-9912" && stored.status === "verified", JSON.stringify(stored));
    created.data.push(stored.id);
    assert(!(await agentOf(A)).waiting, "agent still parked after the projection was answered");
    return "announced once, answered inline, agent resumed";
  });

  await test("deep link opens the exact action, and marks it viewed", async () => {
    const r = await run(A, "owner__request_owner_action", { kind: "decision", title: "Pick the shipping carrier", reason: "Both are in policy.", choices: [{ value: "a", label: "Carrier A" }, { value: "b", label: "Carrier B" }] }, scope);
    assert(r.ok, r.error);
    const a = await find((x) => x.title === "Pick the shipping carrier");
    const direct = (await api(`/api/action-center/${a.id}`)).action;
    assert(direct.id === a.id && direct.payload.choices.length === 2, JSON.stringify(direct.payload));
    const after = await find((x) => x.id === a.id);
    assert(after.viewedAt, "viewedAt not recorded");
    await api(`/api/action-center/${a.id}`, { choice: "a", note: "cheaper" });
    const msgs = (await api(`/api/agents/${A}/messages`)).messages;
    assert(msgs.some((m) => m.origin === "system" && /Carrier|chose: a/i.test(m.content)), "the decision was not passed to the agent");
    return "?action=<id> resolves to the same record";
  });

  await test("no ghost waits: a resolved action leaves nothing behind, and the page empties", async () => {
    for (const a of (await center()).actions) await api(`/api/action-center/${a.id}`, { dismiss: true, note: "suite cleanup" }).catch(() => undefined);
    const end = await center();
    assert(end.actions.length === 0, `still open: ${JSON.stringify(end.actions.map((a) => a.title))}`);
    assert(end.counts.total === 0 && end.counts.blocking === 0, JSON.stringify(end.counts));
    // and no agent anywhere claims to be waiting
    const agents = (await api("/api/agents")).agents.filter((x) => x.waiting);
    assert(agents.length === 0, `agents still waiting with an empty Needs You: ${JSON.stringify(agents.map((x) => [x.name, x.waiting.headline]))}`);
    return "empty page means nothing is blocked";
  });

  await test("an action whose agent is deleted disappears instead of lingering", async () => {
    const temp = await mk("Action Center Temp", ["company_profile"]);
    await run(temp.id, "owner__request_owner_action", { kind: "data", title: "Temp value", reason: "testing orphan cleanup", fields: [{ key: `${KEY}.temp`, label: "Temp", type: "text" }] }, `${scope}:temp`);
    assert(await find((x) => x.agentId === temp.id), "action not created");
    await api(`/api/agents/${temp.id}`, null, "DELETE");
    assert(!(await find((x) => x.agentId === temp.id)), "orphaned action still listed");
    return "reconciled on read";
  });
} finally {
  if (!KEEP) {
    for (const a of (await center().catch(() => ({ actions: [] }))).actions) await api(`/api/action-center/${a.id}`, { dismiss: true }).catch(() => undefined);
    for (const id of created.data) await api(`/api/company/custom-data/${id}`, null, "DELETE").catch(() => undefined);
    for (const id of created.methods) await api(`/api/payments/methods/${id}`, null, "DELETE").catch(() => undefined);
    await api(`/api/agents/${A}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept agent ${A}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
