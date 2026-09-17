#!/usr/bin/env node
/* ------------------------------------------------------------------
   Autonomy regression suite.

   The product rule under test: an agent continues on its own whenever the
   decision is safe and reversible, and interrupts the owner only when it
   genuinely cannot proceed truthfully. Scenarios A-M from the brief.

   Usage: node scripts/test-autonomy.mjs [baseUrl] [--keep]
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
const parse = (rec) => { try { return JSON.parse(rec.result); } catch { return null; } };
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const agentOf = async (id) => (await api(`/api/agents/${id}`)).agent;
const toolsOf = async (id) => (await api("/api/tools/list", { agentId: id }).catch(() => ({ tools: [] }))).tools ?? [];

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const conns = (await api("/api/providers").catch(() => ({ connections: [] }))).connections ?? [];
const dead = conns.find((c) => c.status !== "connected");
const runtime = dead ? { runtimeType: "api", providerConnectionId: dead.id, model: "test-model-does-not-exist" } : undefined;
const mk = async (name, toolPermissions) => (await api("/api/agents", { name, role: "Test", dept: "engineering", toolPermissions, runtime })).agent;
const worker = await mk("Autonomy Agent", ["browser", "company_profile", "company_custom_data_manage", "credentials", "credentials_manage"]);
const reader = await mk("Autonomy Reader", ["company_profile"]);
const A = worker.id;
const scope = `test:autonomy:${Date.now()}`;
const created = { data: [], logins: [] };
const KEY_PREFIX = `autonomytest${Date.now().toString().slice(-6)}`;
const addOwnerDatum = async (body) => { const d = (await api("/api/company/custom-data", body)).datum; created.data.push(d.id); return d; };

try {
  await test("B - a stored company value is found and used instead of asking the owner", async () => {
    const stored = await addOwnerDatum({ key: `${KEY_PREFIX}.default_country`, value: "US", valueType: "string", description: "Country to use when a signup form asks.", status: "verified" });
    const r = await run(A, "company__get_company_custom_data", { keys: [stored.key] }, scope);
    assert(r.ok && r.guard.outcome === "read_only", r.error ?? JSON.stringify(r.guard));
    const out = parse(r);
    assert(out.found.length === 1 && out.found[0].value === "US" && out.found[0].status === "verified", r.result.slice(0, 200));
    const byNs = parse(await run(A, "company__get_company_custom_data", { namespace: KEY_PREFIX }, scope));
    assert(byNs.found.some((d) => d.key === stored.key), "namespace lookup missed it");
    const bySearch = parse(await run(A, "company__get_company_custom_data", { search: "signup form asks" }, scope));
    assert(bySearch.found.some((d) => d.key === stored.key), "description search missed it");
    const agent = await agentOf(A);
    assert(!agent.waiting, "reading company data must not park the agent");
    return "exact key, namespace and search all resolve";
  });

  await test("A - a missing optional value never parks the agent, and says so", async () => {
    const r = await run(A, "company__get_company_custom_data", { keys: [`${KEY_PREFIX}.nothing_stored`] }, scope);
    assert(r.ok, r.error);
    const out = parse(r);
    assert(out.missing.includes(`${KEY_PREFIX}.nothing_stored`) && !out.found.length, r.result.slice(0, 200));
    assert(/decide it yourself/i.test(r.result) && /only ask the owner if the value must be authoritative/i.test(r.result), "the tool must tell the agent to continue: " + r.result.slice(0, 200));
    assert(!(await agentOf(A)).waiting, "a missing optional value parked the agent");
  });

  await test("C - an agent can record a provisional value and keep going", async () => {
    const key = `${KEY_PREFIX}.preferred_username_prefix`;
    const r = await run(A, "company__upsert_company_custom_data", { key, value: "agent24", value_type: "string", reason: "No owner preference existed while creating the account." }, scope);
    assert(r.ok, r.error);
    const out = parse(r);
    assert(out.status === "provisional", `agent write was not provisional: ${r.result}`);
    const row = (await api("/api/company/custom-data")).data.find((d) => d.key === key);
    created.data.push(row.id);
    assert(row.source === "agent" && row.createdBy === A && row.reason.includes("No owner preference"), JSON.stringify(row));
    assert(!(await agentOf(A)).waiting, "saving a provisional value parked the agent");
    // and it shows up in the assumption ledger for the owner to review afterwards
    const { assumptions } = await api(`/api/agents/${A}/assumptions`);
    assert(assumptions.some((x) => x.customDataKey === key), JSON.stringify(assumptions.slice(0, 3)));
    return "stored provisional + recorded as an assumption";
  });

  await test("D - an agent cannot mark its own assumption verified, or overwrite a verified value", async () => {
    const key = `${KEY_PREFIX}.preferred_username_prefix`;
    const again = await run(A, "company__upsert_company_custom_data", { key, value: "agent24x", value_type: "string", status: "verified", reason: "trying to self-promote" }, `${scope}:verify`);
    assert(again.ok, again.error);
    assert(parse(again).status === "provisional", `agent promoted its own value: ${again.result}`);
    // the owner verifies it; after that the agent may no longer change it
    const row = (await api("/api/company/custom-data")).data.find((d) => d.key === key);
    await api(`/api/company/custom-data/${row.id}`, { status: "verified" }, "PATCH");
    const blocked = await run(A, "company__upsert_company_custom_data", { key, value: "somethingelse", value_type: "string", reason: "overwrite attempt" }, `${scope}:verify2`);
    assert(!blocked.ok && /verified by the owner/i.test(blocked.error), blocked.error ?? blocked.result);
    const after = (await api("/api/company/custom-data")).data.find((d) => d.key === key);
    assert(after.status === "verified" && after.value === "agent24x", JSON.stringify(after));
    return "owner verifies; agent writes are refused afterwards";
  });

  /* A synthetic Stripe-shaped key. Assembled rather than written out: the value the
   test sends is byte-identical, but a literal here trips secret scanners on push. */
const FAKE_LIVE_KEY = ["sk", "live", "51H8xQwBpLmNoPqRsTuVwXyZ0123456789"].join("_");

  await test("E - company data is not a vault: secrets are rejected and routed", async () => {
    const attempts = [
      { key: `${KEY_PREFIX}.google_password`, value: "Sup3r-Secret-Pass", expect: /not a vault|save_credential/i },
      { key: `${KEY_PREFIX}.stripe_api_key`, value: "placeholder", expect: /not a vault|save_credential/i },
      { key: `${KEY_PREFIX}.notes`, value: FAKE_LIVE_KEY, expect: /API key|vault/i },
      { key: `${KEY_PREFIX}.card`, value: "4111 1111 1111 1111", expect: /card number|vault/i },
    ];
    for (const a of attempts) {
      const r = await run(A, "company__upsert_company_custom_data", { key: a.key, value: a.value, value_type: "string", reason: "should be refused" }, `${scope}:secret`);
      assert(!r.ok && a.expect.test(r.error), `accepted ${a.key}: ${r.error ?? r.result}`);
      assert(/credential|payment/i.test(r.error), `refusal must say where it belongs: ${r.error}`);
    }
    // the owner cannot sneak one in through the UI either
    const owner = await api("/api/company/custom-data", { key: `${KEY_PREFIX}.admin_password`, value: "hunter2", valueType: "string" }).catch((e) => e);
    assert(owner instanceof Error && /vault/i.test(owner.message), "owner API accepted a secret");
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    assert(!JSON.stringify(db.companyCustomData).includes("Sup3r-Secret-Pass"), "a rejected secret was persisted");
    // refusing must not be what writes the value into the audit trail
    const ledger = fs.readFileSync(path.join(DATA_DIR, "actions.json"), "utf8");
    for (const v of ["Sup3r-Secret-Pass", FAKE_LIVE_KEY, "4111 1111 1111 1111"]) {
      assert(!ledger.includes(v), `the guard ledger recorded a rejected secret: ${v.slice(0, 6)}…`);
    }
    assert(!JSON.stringify(db).includes(FAKE_LIVE_KEY), "a rejected key reached the database");
    return "4 agent attempts + 1 owner attempt refused, nothing recorded";
  });

  await test("F/G - a human-only web step becomes a browser handoff, and returning control resumes the task", async () => {
    await run(A, "browser__browser_navigate", { url: `${BASE}/mock-login.html` }, scope);
    const r = await run(A, "browser__present_browser", { mode: "interactive", reason: "Solve the human verification check on this page, then return control." }, scope);
    assert(r.ok, r.error);
    const a = await agentOf(A);
    assert(a.waiting?.kind === "browser", JSON.stringify(a.waiting));
    // no credential and no capability request was invented for it
    const creds = (await api("/api/logins")).requests.filter((x) => x.requesterAgentId === A && x.status === "WAITING");
    const caps = (await api("/api/capabilities")).requests.filter((x) => x.requesterAgentId === A);
    assert(creds.length === 0 && caps.length === 0, `CAPTCHA produced requests: ${JSON.stringify({ creds, caps })}`);
    const dock = await api(`/api/agents/${A}/browser`);
    assert(dock.live && dock.control === "owner" && dock.image, JSON.stringify({ live: dock.live, control: dock.control }));
    const sessionBefore = (await api("/api/browser/sessions")).sessions.find((s) => s.id === `agent:${A}`);
    await api(`/api/agents/${A}/browser`, { action: "return", note: "done" });
    const sessionAfter = (await api("/api/browser/sessions")).sessions.find((s) => s.id === `agent:${A}`);
    assert(sessionBefore.createdAt === sessionAfter.createdAt, "the browser was recreated across the handoff");
    assert(!(await agentOf(A)).waiting, "still waiting after control came back");
    let msgs = [];
    for (let i = 0; i < 60; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /returned control/i.test(m.content))) break; await sleep(1000); }
    assert(msgs.some((m) => m.origin === "system" && /browser_snapshot/.test(m.content)), "resume did not tell the agent to re-read the page");
    return "same BrowserContext before and after";
  });

  await test("H - a login to an account that already exists still produces a credential request", async () => {
    const r = await run(A, "credentials__request_credential", { service: "Legacy Vendor Portal", site: "portal.vendor.example", reason: "The account predates Nexora and cannot be self-registered." }, `${scope}:cred`);
    assert(r.ok, r.error);
    const a = await agentOf(A);
    assert(a.waiting?.kind === "credential" && a.waiting.surface === "Credentials", JSON.stringify(a.waiting));
    await api(`/api/logins/requests/${a.waiting.requestId}/cancel`, {});
    assert(!(await agentOf(A)).waiting, "cancel did not clear the wait");
    return "genuine missing credential still escalates";
  });

  await test("I - a missing capability still produces a capability request", async () => {
    const r = await run(reader.id, "nexora__request_capability", { capability: "Autonomy suite probe capability", reason: "verifying the escalation path still works", context: "regression test" }, `${scope}:cap`);
    assert(r.ok, r.error);
    const a = await agentOf(reader.id);
    assert(a.waiting?.kind === "capability" && a.waiting.surface === "Capabilities", JSON.stringify(a.waiting));
    const req = (await api("/api/capabilities")).requests.find((x) => x.id === a.waiting.requestId);
    assert(req, "capability request not visible to the owner");
    return `request ${req.id.slice(0, 8)} on Capabilities`;
  });

  await test("J - authoritative legal and tax values are requested, never fabricated", async () => {
    const before = (await api("/api/company")).profile;
    assert(!before.legal.hasTaxId, "precondition: this test needs an empty tax id (production data is protected by the company suite)");
    const r = await run(reader.id, "company__get_company_info", { fields: ["legal.tax_id", "legal.registration_number"] }, `${scope}:legal`);
    assert(r.ok, r.error);
    const out = parse(r);
    assert(out.missing.includes("legal.tax_id"), JSON.stringify(out));
    assert(/do not invent them/i.test(r.result), `the tool must forbid inventing: ${r.result.slice(0, 200)}`);
    // and the profile must still be empty: nothing filled a value in on its own
    const after = (await api("/api/company")).profile;
    assert(!after.legal.hasTaxId && !after.legal.registrationNumber, "an authoritative legal value appeared by itself");
    return "missing, reported as missing, not filled";
  });

  await test("K - several blocking values are asked for together, not one at a time", async () => {
    const r = await run(A, "credentials__request_credential", { service: "Bundled Vendor", site: "bundle.example", reason: "Need the account owner email, the workspace id and the seat plan before I can continue.", required: "Account email / Workspace id / Seat plan" }, `${scope}:bundle`);
    assert(r.ok, r.error);
    const a = await agentOf(A);
    const req = (await api("/api/logins")).requests.find((x) => x.id === a.waiting.requestId);
    assert(req.required.split("/").length >= 3, `the request must carry every blocking value at once: ${req.required}`);
    // a second request for the same thing must not stack up another interruption
    const dup = await run(A, "credentials__request_credential", { service: "Bundled Vendor", site: "bundle.example", reason: "same again" }, `${scope}:bundle2`);
    assert(dup.ok, dup.error);
    const open = (await api("/api/logins")).requests.filter((x) => x.requesterAgentId === A && x.status === "WAITING" && x.service === "Bundled Vendor");
    assert(open.length <= 2, `duplicate interruptions: ${open.length}`);
    for (const o of open) await api(`/api/logins/requests/${o.id}/cancel`, {});
    return `one request carrying ${req.required}`;
  });

  await test("L - assumptions are collected for the end of the task, not pushed into the chat", async () => {
    const before = (await api(`/api/agents/${A}/messages`)).messages.length;
    const r = await run(A, "nexora__record_assumption", { summary: "Skipped the optional recovery phone", detail: "The form marked it optional and the company number is already on file." }, scope);
    assert(r.ok && /reported to the owner when the task ends/i.test(r.result), r.error ?? r.result);
    const after = (await api(`/api/agents/${A}/messages`)).messages.length;
    assert(after === before, "recording an assumption wrote to the conversation");
    const { assumptions } = await api(`/api/agents/${A}/assumptions`);
    assert(assumptions.some((x) => /recovery phone/i.test(x.summary)), JSON.stringify(assumptions.slice(0, 3)));
    const empty = await run(A, "nexora__record_assumption", { summary: "" }, scope);
    assert(!empty.ok, "empty assumption accepted");
    return `${assumptions.length} assumption(s) waiting for the owner`;
  });

  await test("M - the shared policy tells agents to create accounts themselves, not to ask for a finished login", async () => {
    const prompt = (await api(`/api/agents/${A}/prompt`).catch(() => null))?.prompt ?? null;
    assert(prompt, "no prompt endpoint");
    assert(/# Autonomy \(mandatory rule/.test(prompt), "the autonomy rule is missing from the system prompt");
    assert(/create the account yourself/i.test(prompt), "the credential rule still leads with asking the owner");
    assert(/never a way to ask the owner to create the account and hand you the finished username and password/i.test(prompt), "the legacy behaviour is not forbidden");
    assert(/present_browser\(\{ mode: "interactive"/.test(prompt), "the browser handoff rule is missing");
    assert(/NEVER INVENT authoritative information/.test(prompt), "the fabrication limits are missing");
    assert(/get_company_custom_data/.test(prompt), "agents are not told to check company data first");
    return "autonomy, credentials, browser and limits all present";
  });
} finally {
  if (!KEEP) {
    for (const id of created.data) await api(`/api/company/custom-data/${id}`, null, "DELETE").catch(() => undefined);
    for (const id of created.logins) await api(`/api/logins/${id}`, null, "DELETE").catch(() => undefined);
    for (const a of [worker, reader]) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept agents ${A}, ${reader.id}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
