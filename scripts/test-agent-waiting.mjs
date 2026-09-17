#!/usr/bin/env node
/* ------------------------------------------------------------------
   Agent waiting-state regression suite.

   The ghost wait: an agent header saying "Waiting for capability ·
   credential for Google Account" while the Capabilities page had no such
   request — because the request was a CREDENTIAL request on another page
   and the label/link never said so, and because nothing ever checked that
   the backing request still existed.

   Scenarios A-G from the brief, plus the browser handoff state.
   Usage: node scripts/test-agent-waiting.mjs [baseUrl] [--keep]
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
const agentOf = async (id) => (await api(`/api/agents/${id}`)).agent;

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const conns = (await api("/api/providers").catch(() => ({ connections: [] }))).connections ?? [];
const dead = conns.find((c) => c.status !== "connected");
const runtime = dead ? { runtimeType: "api", providerConnectionId: dead.id, model: "test-model-does-not-exist" } : undefined;
const mk = async (name, toolPermissions) => (await api("/api/agents", { name, role: "Test", dept: "engineering", toolPermissions, runtime })).agent;
const agent = await mk("Waiting Test Agent", ["browser", "credentials", "company_profile", "payments"]);
const A = agent.id;
const scope = `test:waiting:${Date.now()}`;
const created = { logins: [], methods: [] };

try {
  await test("A - a credential request produces a waiting state that names and links its real surface", async () => {
    const r = await run(A, "credentials__request_credential", { service: "Google Account", site: "accounts.google.com", login_url: "https://accounts.google.com/", reason: "The signup form needs the company Google login." }, scope);
    assert(r.ok, r.error);
    const a = await agentOf(A);
    assert(a.waiting, "no waiting state");
    assert(a.waiting.kind === "credential", `kind is ${a.waiting.kind}`);
    assert(a.waiting.surface === "Credentials", `surface is ${a.waiting.surface}`);
    assert(!/capabilit/i.test(a.waiting.headline), `headline still says capability: ${a.waiting.headline}`);
    assert(a.waiting.label === "Google Account (accounts.google.com)", a.waiting.label);
    // the backing request is real, open, and reachable at the linked surface
    const logins = await api("/api/logins");
    const req = logins.requests.find((x) => x.id === a.waiting.requestId);
    assert(req && req.status === "WAITING", `backing request not open: ${JSON.stringify(req)}`);
    assert(a.waiting.href === `/credentials?request=${req.id}`, a.waiting.href);
    // and it is NOT on the Capabilities page, which is what made the old label a ghost
    const caps = await api("/api/capabilities");
    assert(!caps.requests.some((x) => x.id === req.id), "credential request leaked into capability requests");
    return `${a.waiting.headline} -> ${a.waiting.href}`;
  });

  await test("F - the Google credential request is visible on the surface the status points at", async () => {
    const a = await agentOf(A);
    const logins = await api("/api/logins");
    const waitingCards = logins.requests.filter((r) => r.status === "WAITING");
    assert(waitingCards.some((r) => r.id === a.waiting.requestId && r.service === "Google Account" && r.site === "accounts.google.com"), JSON.stringify(waitingCards));
    assert(waitingCards.every((r) => r.requesterAgentId && r.requesterName), "requests must name their requester so the owner can act");
    return `${waitingCards.length} credential request(s) on /credentials`;
  });

  await test("B - resolving the request clears the waiting state and resumes the agent", async () => {
    const a = await agentOf(A);
    const requestId = a.waiting.requestId;
    const c = await api("/api/logins", { name: `Google Account - waiting test ${Date.now()}`, service: "Google Account", site: "accounts.google.com", description: "Google account used by the waiting-state regression suite to verify resume behaviour.", username: "waiting@example.com", password: "Waiting-Test-1234", requestId });
    created.logins.push(c.credential.id);
    const after = await agentOf(A);
    assert(!after.waiting, `still waiting: ${JSON.stringify(after.waiting)}`);
    const req = (await api("/api/logins")).requests.find((x) => x.id === requestId);
    assert(req.status === "RESOLVED", req.status);
    let msgs = [];
    for (let i = 0; i < 60; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /RESOLVED/.test(m.content))) break; await sleep(1000); }
    assert(msgs.some((m) => m.origin === "system" && /RESOLVED/.test(m.content)), "resume message not delivered");
    return "resolved, cleared, resumed";
  });

  await test("E - cancelling the request clears the waiting state", async () => {
    const r = await run(A, "credentials__request_credential", { service: "Hooli", site: "hooli.example", reason: "cancel path" }, `${scope}:cancel`);
    assert(r.ok, r.error);
    const a = await agentOf(A);
    assert(a.waiting && a.waiting.kind === "credential", "not waiting");
    await api(`/api/logins/requests/${a.waiting.requestId}/cancel`, {});
    const after = await agentOf(A);
    assert(!after.waiting, `still waiting after cancel: ${JSON.stringify(after.waiting)}`);
    return "cancel clears the wait";
  });

  await test("C - a failed request creation leaves the agent running, never waiting", async () => {
    const before = await agentOf(A);
    assert(!before.waiting, "precondition: agent should be idle");
    for (const args of [{ service: "", site: "nowhere.example", reason: "missing service" }, { service: "Broken", site: "", reason: "missing site" }]) {
      const r = await run(A, "credentials__request_credential", args, `${scope}:fail`);
      assert(!r.ok, `invalid request was accepted: ${JSON.stringify(args)}`);
      const a = await agentOf(A);
      assert(!a.waiting, `agent left waiting after a failed creation: ${JSON.stringify(a.waiting)}`);
    }
    // the same must hold for company information requests
    const bad = await run(A, "company__request_company_info", { field: "", needed_by: "x", reason: "y" }, `${scope}:fail2`);
    assert(!bad.ok, "empty field accepted");
    assert(!(await agentOf(A)).waiting, "company request failure left a waiting state");
    return "no request, no wait";
  });

  await test("D - a waiting state pointing at a missing request is reconciled away", async () => {
    const r = await run(A, "credentials__request_credential", { service: "Ghost Service", site: "ghost.example", reason: "will be deleted underneath the agent" }, `${scope}:ghost`);
    assert(r.ok, r.error);
    const a = await agentOf(A);
    const requestId = a.waiting.requestId;
    // delete the backing request behind the app's back - the worst case for a ghost wait
    const file = path.join(DATA_DIR, "nexora.json");
    const db = JSON.parse(fs.readFileSync(file, "utf8"));
    db.credentialRequests = db.credentialRequests.filter((x) => x.id !== requestId);
    assert(db.agents.find((x) => x.id === A).waitingFor, "agent record should still claim to be waiting");
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
    const after = await agentOf(A);
    assert(!after.waiting, `ghost wait survived: ${JSON.stringify(after.waiting)}`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")).agents.find((x) => x.id === A);
    assert(!persisted.waitingFor, "stale waitingFor was not repaired on disk");
    const list = (await api("/api/agents")).agents.find((x) => x.id === A);
    assert(!list.waiting, "agent list still shows the ghost");
    return "repaired on read, not just hidden";
  });

  await test("G - the request is scoped to its requester and stays visible to the owner", async () => {
    const other = await mk("Waiting Test Agent 2", ["credentials"]);
    try {
      const r = await run(other.id, "credentials__request_credential", { service: "Scoped Service", site: "scoped.example", reason: "scoping check" }, `${scope}:scope`);
      assert(r.ok, r.error);
      const mine = await agentOf(A);
      const theirs = await agentOf(other.id);
      assert(!mine.waiting, "the other agent's request marked the wrong agent as waiting");
      assert(theirs.waiting && theirs.waiting.kind === "credential", "requester is not waiting");
      const requests = (await api("/api/logins")).requests;
      const found = requests.find((x) => x.id === theirs.waiting.requestId);
      assert(found && found.requesterAgentId === other.id && found.status === "WAITING", "owner cannot see the request in the shared list");
      await api(`/api/logins/requests/${found.id}/cancel`, {});
    } finally {
      await api(`/api/agents/${other.id}`, null, "DELETE").catch(() => undefined);
    }
    return "one owner list, requester recorded on the request";
  });

  await test("payments above the limit now show on the requesting agent and link to Payments", async () => {
    const original = (await api("/api/payments/settings")).settings;
    const m = (await api("/api/payments/methods", { type: "CARD", displayName: `Waiting Suite Card ${Date.now()}`, description: "Card used by the waiting-state suite to create an above-limit payment request.", cardholderName: "Nexora Test", cardNumber: "4111111111111111", expirationMonth: 8, expirationYear: 2029, cvv: "123", billing: { postalCode: "78701", country: "US" } })).method;
    created.methods.push(m.id);
    await api("/api/payments/settings", { autoApproveLimit: 1 }, "PUT");
    try {
      const p = JSON.parse((await run(A, "payments__request_payment", { merchant: "Waiting Vendor", amount: 42, reason: "above the limit" }, `${scope}:pay`)).result);
      assert(p.status === "WAITING_FOR_APPROVAL", p.status);
      const a = await agentOf(A);
      assert(a.waiting && a.waiting.kind === "payment" && a.waiting.surface === "Payments", JSON.stringify(a.waiting));
      assert(a.waiting.href === `/payments/requests?request=${p.payment_request_id}`, a.waiting.href);
      await api(`/api/payments/requests/${p.payment_request_id}/reject`, { note: "test" });
      assert(!(await agentOf(A)).waiting, "rejection left the agent waiting");
    } finally {
      await api("/api/payments/settings", { autoApproveLimit: original.autoApproveLimit, defaultPaymentMethodId: original.defaultPaymentMethodId }, "PUT").catch(() => undefined);
    }
    return "payment waits are modelled and cleared on rejection";
  });

  await test("browser handoff is its own state: no fake capability request, control returns and resumes", async () => {
    const view = await run(A, "browser__present_browser", { mode: "view", reason: "Look at this page with me." }, `${scope}:dock`);
    assert(view.ok, view.error);
    let a = await agentOf(A);
    assert(!a.waiting, "VIEW must not block the agent");
    const dock = await api(`/api/agents/${A}/browser`);
    assert(dock.handoff && dock.handoff.mode === "VIEW" && dock.control === "agent", JSON.stringify(dock.handoff));
    const inter = await run(A, "browser__present_browser", { mode: "interactive", reason: "Solve the human check on this page, then return control." }, `${scope}:dock`);
    assert(inter.ok && /END YOUR TURN/i.test(inter.result), inter.error ?? inter.result);
    a = await agentOf(A);
    assert(a.waiting && a.waiting.kind === "browser" && a.waiting.headline === "Browser handed to you", JSON.stringify(a.waiting));
    assert(a.waiting.href === `/agents/${A}?browser=1`, a.waiting.href);
    // no capability or credential request was invented for a browser step
    const caps = (await api("/api/capabilities")).requests.filter((r) => r.requesterAgentId === A);
    assert(caps.length === 0, `browser handoff created capability requests: ${JSON.stringify(caps)}`);
    const control = await api(`/api/agents/${A}/browser`);
    assert(control.control === "owner", JSON.stringify(control.control));
    const back = await api(`/api/agents/${A}/browser`, { action: "return", note: "done" });
    assert(back.handoff.status === "RETURNED", JSON.stringify(back.handoff));
    a = await agentOf(A);
    assert(!a.waiting, `still waiting after return: ${JSON.stringify(a.waiting)}`);
    let msgs = [];
    for (let i = 0; i < 60; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /returned control/i.test(m.content))) break; await sleep(1000); }
    assert(msgs.some((m) => m.origin === "system" && /returned control/i.test(m.content) && /browser_snapshot/.test(m.content)), "agent was not resumed with a fresh-look instruction");
    return "view -> interactive -> returned, agent resumed";
  });

  await test("owner input is refused while the agent holds the browser", async () => {
    const r = await api(`/api/agents/${A}/browser`, { action: "click", x: 10, y: 10 }).catch((e) => e);
    assert(r instanceof Error && /controlling this browser/i.test(r.message), `input was allowed: ${r instanceof Error ? r.message : JSON.stringify(r)}`);
    const nothing = await api(`/api/agents/${A}/browser`, { action: "return" }).catch((e) => e);
    assert(nothing instanceof Error && /Nothing to return/i.test(nothing.message), String(nothing.message ?? nothing));
  });
} finally {
  if (!KEEP) {
    for (const id of created.logins) await api(`/api/logins/${id}`, null, "DELETE").catch(() => undefined);
    for (const id of created.methods) await api(`/api/payments/methods/${id}`, null, "DELETE").catch(() => undefined);
    await api(`/api/agents/${A}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept agent ${A}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
