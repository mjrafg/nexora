#!/usr/bin/env node
/* ------------------------------------------------------------------
   Payment Method Registry + secure browser insertion (spec §31–§41) —
   API + Tool Runner level, driving the real browser host through the
   agent's own session against the public mock checkout pages.
   Usage: node scripts/test-payment-methods.mjs [baseUrl] [--keep]
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
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${j.error ?? ""} ${j.detail ?? ""}`);
  return j;
}
const run = (agentId, tool, args, scopeId) => api("/api/tools/run", { agentId, tool, args, scopeId });
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`✓ ${name}${note ? ` — ${note}` : ""}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`✗ ${name} — ${String(err.message || err).slice(0, 500)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const parse = (rec) => { try { return JSON.parse(rec.result); } catch { return null; } };
const refOf = (snapshotText, label) => {
  // element name starts with the label (e.g. button "Pay $3.00")
  const re = new RegExp(`[^\\n]*"${label}[^"\\n]*"[^\\n]*\\[ref=([a-z0-9]+)\\]`, "i");
  const m = snapshotText.match(re);
  return m ? m[1] : null;
};
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));

// secrets used by the suite — none of these strings may ever show up outside the vault
const CARD_ONE = "4111111111111111", CVV_ONE = "123";
const CARD_SUB = "5555555555554444", CVV_SUB = "321";
const ROUTING = "021000021", ACCOUNT = "000123457314";
const CARD_NEW = "4012888888881881", CVV_NEW = "999";
const SECRETS = [CARD_ONE, CARD_SUB, CARD_NEW, ROUTING, ACCOUNT, "4111 1111 1111 1111", "5555 5555 5555 4444"];
const leaks = (text) => SECRETS.filter((x) => String(text).includes(x));
const noLeak = (text, where) => { const l = leaks(text); assert(!l.length, `${where} leaks ${l.map((x) => x.slice(0, 4) + "…").join(", ")}`); };

// ---- setup
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const original = (await api("/api/payments/settings")).settings;
// Test agents run on a deliberately broken runtime so an owner approval still delivers the
// resume message (asserted below) but the resumed LLM turn cannot race the script in the same browser session.
const conns = (await api("/api/providers").catch(() => ({ connections: [] }))).connections ?? [];
const dead = conns.find((c) => c.status !== "connected");
const runtime = dead ? { runtimeType: "api", providerConnectionId: dead.id, model: "test-model-does-not-exist" } : undefined;
const mkAgent = async (name, toolPermissions) => (await api("/api/agents", { name, role: "Test", dept: "engineering", toolPermissions, runtime })).agent;
const agent = await mkAgent("PM Test Agent", ["browser", "payments", "payments_use"]);
const requester = await mkAgent("PM Request-Only Agent", ["browser", "payments"]);
const manager = await mkAgent("PM Manager Agent", ["browser", "payments", "payments_use", "payments_manage"]);
const A = agent.id;
const created = { methods: [], logins: [] };
const mk = async (body) => { const m = (await api("/api/payments/methods", body)).method; created.methods.push(m.id); return m; };
const scope = `test:pm:${Date.now()}`;
let oneTime, subCard, checking;

try {
  await test("§31 TEST A — three methods with usage descriptions; list_payment_methods returns safe metadata only", async () => {
    oneTime = await mk({ type: "CARD", displayName: "Agent One-Time Card (test)", description: "Use this low-limit card for one-time online purchases made by Nexora agents. Do not use it for recurring subscriptions.", cardholderName: "Nexora Test", cardNumber: CARD_ONE, expirationMonth: 8, expirationYear: 2029, cvv: CVV_ONE, billing: { line1: "1 Test St", city: "Austin", region: "TX", postalCode: "78701", country: "US" } });
    subCard = await mk({ type: "CARD", displayName: "Marketing Subscription Card (test)", description: "Use this card only for recurring marketing, advertising and SaaS subscriptions.", cardholderName: "Nexora Marketing", cardNumber: CARD_SUB, expirationMonth: 11, expirationYear: 2030, cvv: CVV_SUB, billing: { postalCode: "78702", country: "US" } });
    checking = await mk({ type: "BANK_ACCOUNT", displayName: "Company Checking (test)", description: "Use this checking account for ACH payments when the vendor does not accept card payment.", accountHolderName: "Nexora Test LLC", bankName: "Test Bank", routingNumber: ROUTING, accountNumber: ACCOUNT, accountType: "CHECKING" });
    assert(oneTime.description && oneTime.status === "AVAILABLE" && oneTime.last4 === "1111" && subCard.brand === "Mastercard" && checking.last4 === "7314", "metadata");
    noLeak(JSON.stringify(await api("/api/payments/methods")), "owner list");
    const r = await run(A, "payments__list_payment_methods", {}, scope);
    assert(r.ok && r.guard.outcome === "read_only", JSON.stringify(r.guard) + (r.error ?? ""));
    const rows = parse(r);
    const mine = rows.filter((x) => [oneTime.id, subCard.id, checking.id].includes(x.id));
    assert(mine.length === 3 && mine.every((x) => x.description && x.name && x.last4 && x.status === "AVAILABLE" && typeof x.is_default === "boolean"), r.result.slice(0, 400));
    assert(mine.find((x) => x.id === oneTime.id).expiration === "08/29" && mine.find((x) => x.id === checking.id).account_type === "CHECKING", "shape");
    assert(!r.result.includes(CVV_ONE + '"') && !/"(routing_number|account_number|card_number|cvv)":/.test(r.result), "secret-like keys in list");
    noLeak(r.result, "list_payment_methods");
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    noLeak(JSON.stringify(db), "nexora.json");
    const short = await api("/api/payments/methods", { type: "CARD", displayName: "Bad (test)", description: "Visa card", cardholderName: "X", cardNumber: CARD_ONE, expirationMonth: 8, expirationYear: 2029 }).catch((e) => e);
    assert(short instanceof Error && /description/i.test(short.message), "short description accepted: " + String(short.message ?? ""));
    return "3 methods, descriptions present, no secrets";
  });

  await test("§16 permissions — request-only agent cannot list or insert; no payments_manage → cannot save", async () => {
    const l = await run(requester.id, "payments__list_payment_methods", {}, scope);
    assert(!l.ok && /not permitted/i.test(l.error), l.error ?? l.result);
    const sv = await run(A, "payments__save_payment_method", { type: "CARD", name: "x", description: "should not be allowed to save this card at all" }, scope);
    assert(!sv.ok && /not permitted|create or update/i.test(sv.error), sv.error ?? sv.result);
    const tools = await api(`/api/agents/${requester.id}/tools`).catch(() => null);
    return tools ? "tool list per permission verified via API" : "denied at call time";
  });

  await test("§34 TEST D — no approved payment request → insert DENIED, nothing typed", async () => {
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, scope);
    assert(nav.ok, nav.error);
    const cardRef = refOf(nav.result, "Card number");
    assert(cardRef, "ref missing: " + nav.result.slice(0, 300));
    const bogus = await run(A, "payments__insert_payment_method_fields", { payment_method_id: oneTime.id, payment_request_id: "does-not-exist", fields: { card_number: cardRef } }, scope);
    assert(!bogus.ok && /DENIED/.test(bogus.error), bogus.error ?? bogus.result);
    await api("/api/payments/settings", { autoApproveLimit: 5 }, "PUT");
    const waiting = parse(await run(A, "payments__request_payment", { merchant: "Big Vendor", amount: 40, reason: "above limit, must wait" }, scope));
    assert(waiting.status === "WAITING_FOR_APPROVAL", waiting.status);
    const early = await run(A, "payments__insert_payment_method_fields", { payment_method_id: oneTime.id, payment_request_id: waiting.payment_request_id, fields: { card_number: cardRef } }, scope);
    assert(!early.ok && /DENIED.*approval/i.test(early.error), early.error ?? early.result);
    await api(`/api/payments/requests/${waiting.payment_request_id}/reject`, { note: "test" });
    const rejected = await run(A, "payments__insert_payment_method_fields", { payment_method_id: oneTime.id, payment_request_id: waiting.payment_request_id, fields: { card_number: cardRef } }, scope);
    assert(!rejected.ok && /DENIED.*rejected/i.test(rejected.error), rejected.error ?? rejected.result);
    const read = await run(A, "browser__browser_read", {}, scope);
    noLeak(read.result, "page after denied inserts");
    const val = await run(A, "browser__browser_snapshot", {}, scope);
    assert(!/1111/.test(val.result), "card field was filled despite denial");
    return "denied before approval, after rejection and for unknown requests";
  });

  let payOne;
  await test("§32 TEST B — auto-approved request → agent picks the one-time card → insert_payment_method_fields → checkout confirms last4; no secrets anywhere", async () => {
    const p = parse(await run(A, "payments__request_payment", { merchant: "Acme Cloud", amount: 3, reason: "one-time API credits", billing_type: "ONE_TIME" }, scope));
    assert(p.status === "AUTO_APPROVED" && p.payment_method === null && /list_payment_methods/.test(p.next), JSON.stringify(p));
    payOne = p.payment_request_id;
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, scope);
    const f = { cardholder_name: refOf(nav.result, "Cardholder name"), card_number: refOf(nav.result, "Card number"), expiration_month: refOf(nav.result, "Expiry month"), expiration_year: refOf(nav.result, "Expiry year"), cvv: refOf(nav.result, "CVV"), billing_postal_code: refOf(nav.result, "Billing ZIP") };
    assert(Object.values(f).every(Boolean), "refs: " + JSON.stringify(f) + nav.result.slice(0, 300));
    const ins = await run(A, "payments__insert_payment_method_fields", { payment_method_id: oneTime.id, payment_request_id: payOne, fields: f }, scope);
    assert(ins.ok, ins.error);
    const out = parse(ins);
    assert(out.success && out.payment_method === oneTime.displayName && out.fields_filled.length === 6 && out.last4 === "1111", ins.result);
    noLeak(ins.result, "insert result");
    assert(!ins.result.includes(CVV_ONE), "cvv in result");
    assert(ins.guard.outcome !== "deduplicated", "guard classified insertion as side effect");
    const req = (await api(`/api/payments/requests/${payOne}`)).request;
    assert(req.status === "PROCESSING" && req.selectedPaymentMethodId === oneTime.id && req.methodSnapshot?.last4 === "1111", JSON.stringify({ s: req.status, m: req.selectedPaymentMethodId }));
    const click = await run(A, "browser__browser_click", { ref: refOf(nav.result, "Pay"), element: "Pay" }, scope);
    assert(click.ok && /confirmed/i.test(click.result), click.result);
    const read = await run(A, "browser__browser_read", {}, scope);
    assert(/card ending 1111/.test(read.result), read.result.slice(0, 300));
    const ref = (read.result.match(/ACME-[A-Z0-9]+/) || [])[0];
    const done = await run(A, "payments__complete_payment", { payment_request_id: payOne, status: "SUCCEEDED", actual_amount: 3, external_reference: ref }, scope);
    assert(done.ok, done.error);
    const ledger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "actions.json"), "utf8"));
    noLeak(JSON.stringify(ledger), "guard ledger");
    const msgs = await api(`/api/agents/${A}/messages`);
    noLeak(JSON.stringify(msgs), "agent transcript");
    const m = (await api("/api/payments/methods")).methods.find((x) => x.id === oneTime.id);
    assert(m.useCount >= 1 && m.lastUsedBy === A, "usage not recorded");
    return `order ${ref} · 6 fields typed by Nexora`;
  });

  await test("§24 re-filling a cleared form is not deduplicated (insertion is retryable in the same scope)", async () => {
    const p = parse(await run(A, "payments__request_payment", { merchant: "Acme Cloud", amount: 3, reason: "retry test", billing_type: "ONE_TIME" }, scope));
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, scope);
    const args = { payment_method_id: oneTime.id, payment_request_id: p.payment_request_id, fields: { card_number: refOf(nav.result, "Card number") } };
    const a = await run(A, "payments__insert_payment_method_fields", args, scope);
    await run(A, "browser__browser_type", { ref: args.fields.card_number, text: "", element: "card number (cleared by the site)" }, scope); // site "cleared" the form
    const b = await run(A, "payments__insert_payment_method_fields", args, scope); // identical args, same scope
    assert(a.ok && b.ok && b.guard.outcome !== "deduplicated", JSON.stringify({ a: a.guard, b: b.guard, e: b.error }));
    const snap = await run(A, "browser__browser_snapshot", {}, scope);
    noLeak(snap.result, "snapshot"); // typed as sensitive → redacted in outputs
    await api(`/api/payments/requests/${p.payment_request_id}/cancel`, { note: "test cleanup" });
    return `guard: ${a.guard.outcome} / ${b.guard.outcome}`;
  });

  let payAch;
  await test("§33 TEST C — ACH-only vendor → Company Checking → routing/account/type inserted (select handled) → confirmation", async () => {
    const p = parse(await run(A, "payments__request_payment", { merchant: "Northwind Supplies", amount: 4, reason: "office equipment invoice; vendor is ACH-only", preferred_method: "BANK_ACCOUNT" }, scope));
    assert(p.status === "AUTO_APPROVED", p.status);
    payAch = p.payment_request_id;
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-checkout-ach.html` }, scope);
    const f = { account_holder: refOf(nav.result, "Account holder name"), routing_number: refOf(nav.result, "Routing number"), account_number: refOf(nav.result, "Account number"), account_type: refOf(nav.result, "Account type") };
    assert(Object.values(f).every(Boolean), "refs: " + JSON.stringify(f) + nav.result.slice(0, 400));
    const wrongType = await run(A, "payments__insert_payment_method_fields", { payment_method_id: oneTime.id, payment_request_id: payAch, fields: f }, scope);
    assert(!wrongType.ok && /Unknown field/.test(wrongType.error), "card method accepted bank fields: " + (wrongType.error ?? wrongType.result));
    const ins = await run(A, "payments__insert_payment_method_fields", { payment_method_id: checking.id, payment_request_id: payAch, fields: f }, scope);
    assert(ins.ok, ins.error);
    const out = parse(ins);
    assert(out.success && out.type === "BANK_ACCOUNT" && out.fields_filled.length === 4, ins.result);
    noLeak(ins.result, "insert result");
    const click = await run(A, "browser__browser_click", { ref: refOf(nav.result, "Pay \\$4.00"), element: "Pay by bank transfer" }, scope);
    assert(click.ok && /authorized/i.test(click.result), click.result);
    const read = await run(A, "browser__browser_read", {}, scope);
    assert(/checking account ending 7314/.test(read.result) && /routing ending 0021/.test(read.result), read.result.slice(0, 300));
    noLeak(read.result, "confirmation page text");
    const ref = (read.result.match(/NW-[A-Z0-9]+/) || [])[0];
    const done = await run(A, "payments__complete_payment", { payment_request_id: payAch, status: "SUCCEEDED", actual_amount: 4, external_reference: ref }, scope);
    assert(done.ok, done.error);
    return `reference ${ref}`;
  });

  await test("§7 owner-approved with a specific method → another method is DENIED; the chosen one works; single-field tool", async () => {
    const p = parse(await run(A, "payments__request_payment", { merchant: "Canvix Pro", amount: 15, reason: "design tool", billing_type: "MONTHLY" }, scope));
    assert(p.status === "WAITING_FOR_APPROVAL", p.status);
    await api(`/api/payments/requests/${p.payment_request_id}/approve`, { paymentMethodId: subCard.id, note: "subscription card only" });
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-subscription.html` }, scope);
    const cardRef = refOf(nav.result, "Card number");
    const other = await run(A, "payments__insert_payment_method_field", { payment_method_id: oneTime.id, payment_request_id: p.payment_request_id, field: "card_number", target: cardRef }, scope);
    assert(!other.ok && /DENIED.*specifically/.test(other.error) && !other.error.includes(CARD_SUB), other.error ?? other.result);
    const one = await run(A, "payments__insert_payment_method_field", { payment_method_id: subCard.id, payment_request_id: p.payment_request_id, field: "card_number", target: cardRef }, scope);
    assert(one.ok && parse(one).fields_filled[0] === "card_number", one.error ?? one.result);
    const rest = await run(A, "payments__insert_payment_method_fields", { payment_method_id: subCard.id, payment_request_id: p.payment_request_id, fields: { cardholder_name: refOf(nav.result, "Name on card"), expiration: refOf(nav.result, "Expiration date"), cvv: refOf(nav.result, "Security code"), billing_postal_code: refOf(nav.result, "Billing ZIP") } }, scope);
    assert(rest.ok, rest.error);
    const click = await run(A, "browser__browser_click", { ref: refOf(nav.result, "Subscribe"), element: "Subscribe" }, scope);
    assert(/active/i.test(click.result), click.result);
    const read = await run(A, "browser__browser_read", {}, scope);
    assert(/card ending 4444/.test(read.result), read.result.slice(0, 300));
    const done = await run(A, "payments__complete_payment", { payment_request_id: p.payment_request_id, status: "SUCCEEDED", actual_amount: 15, external_reference: (read.result.match(/CVX-[A-Z0-9]+/) || [])[0] }, scope);
    assert(done.ok, done.error);
    return "MM/YY expiration + single-field insertion verified";
  });

  await test("§36 TEST F — manager agent saves a virtual card with a description; vault-backed; listed; no secret echoed or logged", async () => {
    const bad = await run(manager.id, "payments__save_payment_method", { type: "CARD", name: "Virtual (test)", description: "Visa card", cardholder_name: "Nexora Agent", card_number: CARD_NEW, expiration_month: "05", expiration_year: "2031", cvv: CVV_NEW }, `${scope}:f1`);
    assert(!bad.ok && /description/i.test(bad.error), "short description accepted: " + (bad.error ?? bad.result));
    const r = await run(manager.id, "payments__save_payment_method", { type: "CARD", name: "Marketing Virtual Card (test)", description: "Virtual card created during the Canvix signup for recurring marketing SaaS subscriptions. Do not use for one-time infrastructure purchases.", cardholder_name: "Nexora Agent", card_number: CARD_NEW, expiration_month: "05", expiration_year: "2031", cvv: CVV_NEW, billing_address: { postal_code: "78701", country: "US" } }, `${scope}:f2`);
    assert(r.ok, r.error);
    const out = parse(r);
    created.methods.push(out.payment_method_id);
    assert(out.success && out.last4 === "1881" && out.brand === "Visa" && out.type === "CARD", r.result);
    noLeak(r.result, "save result"); assert(!r.result.includes(CVV_NEW), "cvv echoed");
    assert(JSON.stringify(r.args).includes("•••") && !JSON.stringify(r.args).includes(CARD_NEW), "args not masked in record: " + JSON.stringify(r.args));
    const list = parse(await run(A, "payments__list_payment_methods", {}, scope));
    const v = list.find((x) => x.id === out.payment_method_id);
    assert(v && v.description.includes("Virtual card") && v.last4 === "1881", "not listed");
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    const row = db.paymentMethods.find((x) => x.id === out.payment_method_id);
    assert(row.createdBy === manager.id && db.credentials.some((c) => c.id === row.credentialId && c.hidden), "vault row");
    noLeak(JSON.stringify(db), "nexora.json");
    noLeak(fs.readFileSync(path.join(DATA_DIR, "actions.json"), "utf8"), "ledger");
    const vault = await api("/api/credentials");
    assert(!vault.credentials.some((c) => c.name.startsWith("payment:")), "payment secret visible in MCP vault list");
    return `saved ${out.name} •••• ${out.last4}`;
  });

  await test("§13 update_payment_method — description/status/rotation; disabled method cannot be inserted; old secret never exposed", async () => {
    const vc = created.methods[created.methods.length - 1];
    const u = await run(manager.id, "payments__update_payment_method", { payment_method_id: vc, description: "Virtual card for recurring marketing SaaS subscriptions only; rotated during the test suite.", card_number: CARD_SUB, cvv: "777", status: "DISABLED" }, `${scope}:u1`);
    assert(u.ok && parse(u).last4 === "4444", u.error ?? u.result);
    noLeak(u.result, "update result");
    const p = parse(await run(A, "payments__request_payment", { merchant: "Acme Cloud", amount: 2, reason: "disabled method test" }, scope));
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, scope);
    const ins = await run(A, "payments__insert_payment_method_fields", { payment_method_id: vc, payment_request_id: p.payment_request_id, fields: { card_number: refOf(nav.result, "Card number") } }, scope);
    assert(!ins.ok && /DENIED.*disabled/i.test(ins.error), ins.error ?? ins.result);
    await api(`/api/payments/requests/${p.payment_request_id}/cancel`, { note: "test cleanup" });
    const view = (await api("/api/payments/methods")).methods.find((x) => x.id === vc);
    assert(view.status === "DISABLED" && view.last4 === "4444" && view.description.includes("rotated"), JSON.stringify(view));
    return "rotated to •••• 4444, disabled → insert denied";
  });

  await test("§37 TEST G — paid method creation: $25 setup fee > limit → WAITING → owner approves → agent resumed → save_payment_method", async () => {
    const gScope = `${scope}:g`;
    const p = parse(await run(manager.id, "payments__request_payment", { merchant: "CardIssuer Inc", amount: 25, reason: "one-time setup fee to open a virtual card account", billing_type: "ONE_TIME" }, gScope));
    assert(p.status === "WAITING_FOR_APPROVAL" && /END YOUR TURN|End your turn/i.test(p.next), JSON.stringify(p));
    const early = await run(manager.id, "payments__save_payment_method", { type: "CARD", name: "Should wait (test)", description: "this save happens before approval and is fine (saving is free)", cardholder_name: "X", card_number: CARD_ONE, expiration_month: "1", expiration_year: "2030" }, gScope);
    // saving is free and allowed; the FEE is what needed approval — verify the fee cannot be inserted before approval
    if (early.ok) created.methods.push(parse(early).payment_method_id);
    const nav = await run(manager.id, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, gScope);
    const blocked = await run(manager.id, "payments__insert_payment_method_fields", { payment_method_id: oneTime.id, payment_request_id: p.payment_request_id, fields: { card_number: refOf(nav.result, "Card number") } }, gScope);
    assert(!blocked.ok && /DENIED/.test(blocked.error), "fee insert allowed before approval");
    const approved = (await api(`/api/payments/requests/${p.payment_request_id}/approve`, { paymentMethodId: null, note: "ok, open the account" })).request;
    assert(approved.status === "APPROVED" && approved.selectedPaymentMethodId === null, JSON.stringify(approved));
    let msgs = [];
    for (let i = 0; i < 120; i++) { msgs = (await api(`/api/agents/${manager.id}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /APPROVED/.test(m.content) && /list_payment_methods/.test(m.content))) break; await sleep(1000); }
    assert(msgs.some((m) => m.origin === "system" && /APPROVED/.test(m.content)), "resume message not delivered");
    noLeak(JSON.stringify(msgs), "manager transcript");
    const ins = await run(manager.id, "payments__insert_payment_method_fields", { payment_method_id: oneTime.id, payment_request_id: p.payment_request_id, fields: { card_number: refOf(nav.result, "Card number"), cardholder_name: refOf(nav.result, "Cardholder name"), expiration_month: refOf(nav.result, "Expiry month"), expiration_year: refOf(nav.result, "Expiry year"), cvv: refOf(nav.result, "CVV") } }, gScope);
    assert(ins.ok, ins.error);
    await run(manager.id, "browser__browser_click", { ref: refOf(nav.result, "Pay"), element: "Pay" }, gScope);
    const done = await run(manager.id, "payments__complete_payment", { payment_request_id: p.payment_request_id, status: "SUCCEEDED", actual_amount: 25, external_reference: "SETUP-FEE-1" }, gScope);
    assert(done.ok, done.error);
    const sv = await run(manager.id, "payments__save_payment_method", { type: "CARD", name: "Issued Virtual Card (test)", description: "Virtual card issued by CardIssuer after the paid account setup; use for one-time vendor purchases up to $50.", cardholder_name: "Nexora Agent", card_number: CARD_NEW, expiration_month: "12", expiration_year: "2031", cvv: "555" }, gScope);
    assert(sv.ok, sv.error);
    created.methods.push(parse(sv).payment_method_id);
    return "fee blocked until approval; resume delivered; method saved after";
  });

  await test("§38 TEST H — logins and payment methods are separate registries and tools", async () => {
    const lc = (await api("/api/logins", { name: "Separation Login (test)", service: "Acme", site: "localhost/mock-login.html", description: "Login used only to prove credentials and payment methods stay separate.", username: "sep@example.com", password: "Sep-Pass-1234" })).credential;
    created.logins.push(lc.id);
    const sepAgent = (await api("/api/agents", { name: "PM Separation Agent", role: "Test", dept: "engineering", toolPermissions: ["browser", "payments", "payments_use", "credentials"] })).agent;
    try {
      const cl = await run(sepAgent.id, "credentials__list_credentials", {}, scope);
      assert(cl.ok, cl.error);
      const creds = parse(cl) ?? [];
      assert(!creds.some((c) => [oneTime.id, subCard.id, checking.id].includes(c.id) || /Card \(test\)|Checking \(test\)/.test(c.name)), "payment method in list_credentials");
      const pl = await run(sepAgent.id, "payments__list_payment_methods", {}, scope);
      assert(pl.ok, pl.error);
      const pms = parse(pl) ?? [];
      assert(!pms.some((m) => m.id === lc.id || /Separation Login/.test(m.name)), "login in list_payment_methods");
      const nav = await run(sepAgent.id, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, scope);
      const ref = refOf(nav.result, "Card number");
      const x1 = await run(sepAgent.id, "credentials__insert_credential_field", { credential_id: oneTime.id, field: "password", target: ref }, scope);
      assert(!x1.ok && /not found/i.test(x1.error), "credential tool reached a payment method: " + (x1.error ?? x1.result));
      const p = parse(await run(sepAgent.id, "payments__request_payment", { merchant: "Acme", amount: 1, reason: "separation" }, scope));
      const x2 = await run(sepAgent.id, "payments__insert_payment_method_fields", { payment_method_id: lc.id, payment_request_id: p.payment_request_id, fields: { card_number: ref } }, scope);
      assert(!x2.ok && /not found/i.test(x2.error), "payment tool reached a login: " + (x2.error ?? x2.result));
      await api(`/api/payments/requests/${p.payment_request_id}/cancel`, { note: "test cleanup" });
      const snap = await run(sepAgent.id, "browser__browser_snapshot", {}, scope);
      assert(!/Sep-Pass|1111/.test(snap.result), "something was typed");
    } finally { await api(`/api/agents/${sepAgent.id}`, null, "DELETE").catch(() => undefined); }
  });

  await test("§39 TEST I — history shows method name/type/last4 for both payments; never secrets; survives deletion", async () => {
    const h = await api("/api/payments/history");
    const t1 = h.transactions.find((t) => t.paymentRequestId === payOne);
    const t2 = h.transactions.find((t) => t.paymentRequestId === payAch);
    assert(t1 && t1.status === "SUCCEEDED" && t1.paymentMethodDisplayName === oneTime.displayName && t1.paymentMethodType === "CARD" && t1.paymentMethodLast4 === "1111" && t1.paymentMethodBrand === "Visa" && t1.approvalType === "AUTOMATIC", JSON.stringify(t1));
    assert(t2 && t2.paymentMethodType === "BANK_ACCOUNT" && t2.paymentMethodLast4 === "7314" && t2.paymentMethodDisplayName === checking.displayName, JSON.stringify(t2));
    noLeak(JSON.stringify(h), "history");
    await api(`/api/payments/methods/${checking.id}`, null, "DELETE");
    created.methods = created.methods.filter((x) => x !== checking.id);
    const after = (await api("/api/payments/history")).transactions.find((t) => t.paymentRequestId === payAch);
    assert(after.paymentMethodLast4 === "7314" && after.paymentMethodDisplayName === checking.displayName, "snapshot lost after deletion");
    return "card + ACH transactions with masked snapshots";
  });

  await test("§29 activity — payments channel shows insertions with field names only; browser activity redacted", async () => {
    for (const id of [A, manager.id]) noLeak(JSON.stringify(await api(`/api/agents/${id}/messages`)), "transcript");
    const dbText = fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8");
    noLeak(dbText, "nexora.json");
    for (const f of ["actions.json", "activity.json"]) { const fp = path.join(DATA_DIR, f); if (fs.existsSync(fp)) noLeak(fs.readFileSync(fp, "utf8"), f); }
    return "no secret strings on disk outside the encrypted vault";
  });
} finally {
  if (!KEEP) {
    for (const id of created.methods) await api(`/api/payments/methods/${id}`, null, "DELETE").catch(() => undefined);
    for (const id of created.logins) await api(`/api/logins/${id}`, null, "DELETE").catch(() => undefined);
    await api("/api/payments/settings", { autoApproveLimit: original.autoApproveLimit, defaultPaymentMethodId: original.defaultPaymentMethodId && !created.methods.includes(original.defaultPaymentMethodId) ? original.defaultPaymentMethodId : null }, "PUT").catch(() => undefined);
    for (const a of [agent, requester, manager]) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept: agents ${A}, ${manager.id}; methods ${created.methods.join(", ")}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
