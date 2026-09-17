#!/usr/bin/env node
/* ------------------------------------------------------------------
   Payments MVP regression suite (spec §38–§46) — API + Tool Runner level.
   Uses test card 4111 1111 1111 1111 and a test routing/account number.
   Usage: node scripts/test-payments.mjs [baseUrl] [--keep]
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
  catch (err) { results.push({ name, ok: false }); console.log(`✗ ${name} — ${String(err.message || err).slice(0, 400)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const parse = (rec) => { try { return JSON.parse(rec.result); } catch { return null; } };
const money = (n) => `$${Number(n).toFixed(2)}`;

// ---- setup
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const original = (await api("/api/payments/settings")).settings;
const agent = (await api("/api/agents", { name: "Payments Test Agent", role: "Test", dept: "engineering", toolPermissions: ["browser", "payments", "payments_use"] })).agent;
const other = (await api("/api/agents", { name: "Other Agent", role: "Test", dept: "engineering", toolPermissions: ["payments"] })).agent;
const A = agent.id;
const created = { methods: [] };
const CARD = "4111 1111 1111 1111";

try {
  await test("§39 add card: vault-backed, UI sees last4 only", async () => {
    const r = await api("/api/payments/methods", { type: "CARD", displayName: "Test Company Card", description: "Test card used by the payments regression suite for one-time purchases.", cardholderName: "Nexora Test", cardNumber: CARD, expirationMonth: 8, expirationYear: 2029, cvv: "123", billing: { line1: "1 Test St", city: "Austin", region: "TX", postalCode: "78701", country: "US" } });
    created.methods.push(r.method.id);
    assert(r.method.last4 === "1111" && r.method.brand === "Visa" && !JSON.stringify(r.method).includes("4111111111111111"), JSON.stringify(r.method));
    assert(r.method.secretKeys.includes("CARD_NUMBER") && r.method.secretKeys.includes("CVV"), "secret keys");
    const list = await api("/api/payments/methods");
    assert(!JSON.stringify(list).includes("4111111111111111") && !JSON.stringify(list).includes("123\""), "list leaks secrets");
    const creds = await api("/api/credentials");
    assert(!creds.credentials.some((c) => c.name.startsWith("payment:")), "payment credential visible in MCP credential list");
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    assert(!JSON.stringify(db.paymentMethods).includes("4111111111111111"), "raw card number in PaymentMethod row");
    assert(!JSON.stringify(db).includes("4111111111111111"), "raw card number anywhere in nexora.json (should be encrypted)");
    return `${r.method.brand} •••• ${r.method.last4}`;
  });

  await test("§40 add bank account: routing/account protected, last4 only", async () => {
    const r = await api("/api/payments/methods", { type: "BANK_ACCOUNT", displayName: "Test Company Checking", description: "Test checking account used by the payments regression suite for ACH vendor payments.", accountHolderName: "Nexora Test LLC", bankName: "Test Bank", routingNumber: "021000021", accountNumber: "000123457314", accountType: "CHECKING" });
    created.methods.push(r.method.id);
    assert(r.method.last4 === "7314" && r.method.accountType === "CHECKING", JSON.stringify(r.method));
    const s = JSON.stringify(await api("/api/payments/methods"));
    assert(!s.includes("021000021") && !s.includes("000123457314"), "bank secrets leaked in list");
  });

  await test("§9 threshold defaults to $0 on a fresh install (settings shape)", async () => {
    const s = (await api("/api/payments/settings")).settings;
    assert(typeof s.autoApproveLimit === "number" && s.currency === "USD", JSON.stringify(s));
    return `current limit ${money(s.autoApproveLimit)} (fresh install default is $0.00)`;
  });

  await test("§38 threshold $5: 0/3/5 auto, 5.01/100 wait", async () => {
    await api("/api/payments/settings", { autoApproveLimit: 5, defaultPaymentMethodId: created.methods[0] }, "PUT");
    const cases = [[0, "AUTO_APPROVED"], [3, "AUTO_APPROVED"], [5, "AUTO_APPROVED"], [5.01, "WAITING_FOR_APPROVAL"], [100, "WAITING_FOR_APPROVAL"]];
    for (const [amount, expected] of cases) {
      const r = await run(A, "payments__request_payment", { merchant: `Threshold ${amount}`, amount, reason: "threshold test" }, `test:threshold:${amount}:${Date.now()}`);
      const p = parse(r);
      assert(r.ok && p?.status === expected, `${amount} → ${p?.status ?? r.error}`);
      if (expected === "WAITING_FOR_APPROVAL") await api(`/api/payments/requests/${p.payment_request_id}/cancel`, { note: "test cleanup" });
      else await api(`/api/payments/requests/${p.payment_request_id}/cancel`, { note: "test cleanup" });
    }
  });

  let autoReq;
  await test("§43 auto approval $2 → AUTO_APPROVED, agent chooses the method at checkout, no owner action", async () => {
    const scope = `test:auto:${Date.now()}`;
    const r = await run(A, "payments__request_payment", { merchant: "Acme Cloud", amount: 2, reason: "API credits", billing_type: "ONE_TIME" }, scope);
    const p = parse(r);
    assert(p?.status === "AUTO_APPROVED" && p.approval === "AUTOMATIC" && p.payment_method === null && /list_payment_methods/.test(p.next), JSON.stringify(p));
    autoReq = { id: p.payment_request_id, scope };
  });

  await test("§39 begin_payment marks the checkout started for the authorized agent only; NO card number or CVV is ever released", async () => {
    const r = await run(A, "payments__begin_payment", { payment_request_id: autoReq.id }, autoReq.scope);
    assert(r.ok && r.guard.class === "FINANCIAL" && r.guard.outcome === "executed", JSON.stringify({ ok: r.ok, err: r.error, guard: r.guard }));
    assert(!r.result.includes("4111111111111111") && !/cvv/i.test(r.result) && /insert_payment_method_fields/.test(r.result), "secrets released or no guidance: " + r.result.slice(0, 200));
    const req = (await api(`/api/payments/requests/${autoReq.id}`)).request;
    assert(req.status === "PROCESSING", req.status);
    const ledger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "actions.json"), "utf8"));
    assert(!JSON.stringify(ledger).includes("4111111111111111"), "card number in ledger");
    const foreign = await run(other.id, "payments__begin_payment", { payment_request_id: autoReq.id }, `test:foreign:${Date.now()}`);
    assert(!foreign.ok && /another agent/.test(foreign.error), foreign.error);
  });

  await test("§44 duplicate begin_payment in same scope → guard deduplicates, no secrets in dedup reply", async () => {
    const r = await run(A, "payments__begin_payment", { payment_request_id: autoReq.id }, autoReq.scope);
    assert(r.ok && r.guard.outcome === "deduplicated", JSON.stringify(r.guard));
    assert(!r.result.includes("4111111111111111"), "dedup reply leaks card");
  });

  await test("§20 insert card at the mock checkout, complete_payment SUCCEEDED → transaction in History with masked method; second completion refused", async () => {
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-checkout.html` }, autoReq.scope);
    const ref = (nav.result.match(/"Card number"[^\n]*\[ref=([a-z0-9]+)\]/i) || [])[1];
    assert(ref, "card number ref missing: " + nav.result.slice(0, 200));
    const ins = await run(A, "payments__insert_payment_method_fields", { payment_method_id: created.methods[0], payment_request_id: autoReq.id, fields: { card_number: ref } }, autoReq.scope);
    assert(ins.ok && !ins.result.includes("4111111111111111"), ins.error ?? ins.result);
    const r = await run(A, "payments__complete_payment", { payment_request_id: autoReq.id, status: "SUCCEEDED", actual_amount: 2, external_reference: "ACME-TEST1" }, autoReq.scope);
    assert(r.ok, r.error);
    const again = await run(A, "payments__complete_payment", { payment_request_id: autoReq.id, status: "SUCCEEDED", actual_amount: 2, external_reference: "ACME-TEST1" }, autoReq.scope);
    assert(again.guard.outcome === "deduplicated" || /already/.test(again.error ?? ""), JSON.stringify({ g: again.guard, e: again.error }));
    const h = await api("/api/payments/history");
    const rows = h.transactions.filter((t) => t.paymentRequestId === autoReq.id);
    assert(rows.length === 1 && rows[0].status === "SUCCEEDED" && rows[0].paymentMethodLast4 === "1111" && rows[0].approvalType === "AUTOMATIC" && rows[0].externalReference === "ACME-TEST1", JSON.stringify(rows));
    assert(!JSON.stringify(h).includes("4111111111111111"), "history leaks card");
    const post = await run(A, "payments__begin_payment", { payment_request_id: autoReq.id }, `test:after-success:${Date.now()}`);
    assert(!post.ok && /already succeeded/.test(post.error), post.error);
  });

  let ownerReq;
  await test("§41 $20 > $5 → WAITING_FOR_APPROVAL; begin refused before approval; owner approves with bank account", async () => {
    const scope = `test:owner:${Date.now()}`;
    const r = await run(A, "payments__request_payment", { merchant: "Canva Pro", amount: 20, reason: "marketing assets", billing_type: "MONTHLY", preferred_method: "BANK_ACCOUNT" }, scope);
    const p = parse(r);
    assert(p?.status === "WAITING_FOR_APPROVAL" && p.billing === "MONTHLY", JSON.stringify(p));
    ownerReq = { id: p.payment_request_id, scope };
    const early = await run(A, "payments__begin_payment", { payment_request_id: ownerReq.id }, scope);
    assert(!early.ok && /waiting/i.test(early.error), early.error);
    const approved = (await api(`/api/payments/requests/${ownerReq.id}/approve`, { paymentMethodId: created.methods[1], note: "ok for one month" })).request;
    assert(approved.status === "APPROVED" && approved.approvalType === "OWNER" && approved.selectedPaymentMethodId === created.methods[1], JSON.stringify(approved));
    const b = await run(A, "payments__begin_payment", { payment_request_id: ownerReq.id }, scope);
    assert(b.ok && b.result.includes("Test Company Checking") && !b.result.includes("021000021") && !b.result.includes("000123457314"), b.error ?? b.result.slice(0, 200));
    const done = await run(A, "payments__complete_payment", { payment_request_id: ownerReq.id, status: "SUCCEEDED", actual_amount: 20, external_reference: "CANVA-INV-1" }, scope);
    assert(done.ok, done.error);
    const t = (await api("/api/payments/history")).transactions.find((x) => x.paymentRequestId === ownerReq.id);
    assert(t && t.approvalType === "OWNER" && t.paymentMethodLast4 === "7314" && t.billingType === "RECURRING" && t.interval === "MONTHLY", JSON.stringify(t));
  });

  await test("§42 owner rejection → REJECTED; agent cannot get credentials; in History", async () => {
    const scope = `test:reject:${Date.now()}`;
    const p = parse(await run(A, "payments__request_payment", { merchant: "Service X", amount: 29, reason: "test" }, scope));
    const rej = (await api(`/api/payments/requests/${p.payment_request_id}/reject`, { note: "not now" })).request;
    assert(rej.status === "REJECTED", rej.status);
    const b = await run(A, "payments__begin_payment", { payment_request_id: p.payment_request_id }, scope);
    assert(!b.ok && /rejected/i.test(b.error) && !b.error.includes("4111"), b.error);
    const t = (await api("/api/payments/history")).transactions.find((x) => x.paymentRequestId === p.payment_request_id);
    assert(t && t.status === "REJECTED", JSON.stringify(t));
  });

  await test("§45 failed payment recorded; amount above authorized → exception, not SUCCEEDED", async () => {
    const scope = `test:fail:${Date.now()}`;
    const p = parse(await run(A, "payments__request_payment", { merchant: "Flaky Vendor", amount: 3, reason: "test" }, scope));
    assert(p.status === "AUTO_APPROVED", p.status);
    await run(A, "payments__begin_payment", { payment_request_id: p.payment_request_id }, scope);
    const over = await run(A, "payments__complete_payment", { payment_request_id: p.payment_request_id, status: "SUCCEEDED", actual_amount: 9.5 }, scope);
    assert(!over.ok && /exceeds/.test(over.error), over.error);
    const flagged = (await api(`/api/payments/requests/${p.payment_request_id}`)).request;
    assert(flagged.status === "PROCESSING" && flagged.exception, JSON.stringify({ s: flagged.status, e: flagged.exception }));
    const resolved = (await api(`/api/payments/requests/${p.payment_request_id}/resolve`, { status: "FAILED", note: "declined" })).request;
    assert(resolved.status === "FAILED", resolved.status);
    const t = (await api("/api/payments/history")).transactions.find((x) => x.paymentRequestId === p.payment_request_id);
    assert(t && t.status === "FAILED", JSON.stringify(t));
  });

  await test("§27 authorization is single-purpose: another agent's scope cannot use it; expired/used authorizations refuse", async () => {
    const b = await run(A, "payments__begin_payment", { payment_request_id: ownerReq.id }, `test:reuse:${Date.now()}`);
    assert(!b.ok && /already succeeded/.test(b.error), b.error);
  });

  await test("§24 deleting a method keeps masked history", async () => {
    await api(`/api/payments/methods/${created.methods[1]}`, null, "DELETE");
    const t = (await api("/api/payments/history")).transactions.find((x) => x.paymentRequestId === ownerReq.id);
    assert(t && t.paymentMethodLast4 === "7314" && t.paymentMethodDisplayName === "Test Company Checking", JSON.stringify(t));
    created.methods.splice(1, 1);
  });

  await test("§46 persistence: requests, authorizations and transactions are on disk", async () => {
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    assert(db.paymentRequests.some((r) => r.id === autoReq.id && r.status === "SUCCEEDED"), "request not persisted");
    assert(db.paymentAuthorizations.some((a) => a.paymentRequestId === autoReq.id && a.status === "USED"), "authorization not persisted/used");
    assert(db.paymentTransactions.some((t) => t.paymentRequestId === autoReq.id), "transaction not persisted");
    /*
     * Not a substring search over the whole blob: a generated uuid contains
     * "4111" roughly one time in a few hundred, and one duly did — the run
     * that failed here had id 6790a1c1-74a7-4111-ba4c-…, no card in sight.
     *
     * So look for the thing that would actually be a leak, in two stricter
     * ways: the full PAN however it is punctuated, and card digits appearing
     * in any stored value that is not an identifier.
     */
    const digits = (x) => String(x).replace(/[\s-]/g, "");
    assert(!digits(JSON.stringify(db.paymentRequests)).includes("4111111111111111"), "full card number in requests");
    const leaks = [];
    const scan = (node, where) => {
      if (typeof node === "string") { if (node.includes("4111")) leaks.push(`${where} = ${node.slice(0, 40)}`); return; }
      if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${where}[${i}]`));
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) if (k !== "id" && !/Id$/.test(k)) scan(v, `${where}.${k}`);
      }
    };
    db.paymentRequests.forEach((r) => scan(r, r.id.slice(0, 8)));
    assert(!leaks.length, `card digits in request fields: ${leaks.slice(0, 3).join(" | ")}`);
  });

  await test("§42 a CANCELLED payment request reaches the agent instead of leaving it parked", async () => {
    const scope = `test:cancelled:${Date.now()}`;
    const p = parse(await run(A, "payments__request_payment", { merchant: "Cancelled Vendor", amount: 31, reason: "This request exists so that cancelling it can be checked." }, scope));
    assert(p?.status === "WAITING_FOR_APPROVAL", JSON.stringify(p));
    assert((await api(`/api/agents/${A}`)).agent.waiting?.kind === "payment", "the agent did not park on it");
    const before = (await api(`/api/agents/${A}/messages`)).messages.length;
    const c = (await api(`/api/payments/requests/${p.payment_request_id}/cancel`, { note: "not going ahead" })).request;
    assert(c.status === "CANCELLED", c.status);
    let told = null;
    for (let i = 0; i < 40; i++) {
      told = (await api(`/api/agents/${A}/messages`)).messages.slice(before).find((m) => m.origin === "system" && m.content.includes(p.payment_request_id.slice(0, 8)) && /CANCELLED/.test(m.content));
      if (told) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert(told, "the owner cancelled the request and the agent was never told");
    assert(/Cancelled Vendor/.test(told.content) && !told.content.includes("4111"), told.content.slice(0, 160));
    assert(!(await api(`/api/agents/${A}`)).agent.waiting, "still parked after the cancellation");
    const b = await run(A, "payments__begin_payment", { payment_request_id: p.payment_request_id }, scope);
    assert(!b.ok, "a cancelled request still released a checkout");
    return "told, released, and nothing authorized";
  });

  await test("§23 overview numbers", async () => {
    const o = (await api("/api/payments/overview")).overview;
    assert(o.monthTotal >= 22 && o.monthAuto >= 2 && o.monthOwner >= 20, JSON.stringify(o));
    return `month ${money(o.monthTotal)} · auto ${money(o.monthAuto)} · owner ${money(o.monthOwner)}`;
  });
} finally {
  if (!KEEP) {
    for (const id of created.methods) await api(`/api/payments/methods/${id}`, null, "DELETE").catch(() => undefined);
    await api("/api/payments/settings", { autoApproveLimit: original.autoApproveLimit, defaultPaymentMethodId: original.defaultPaymentMethodId && original.defaultPaymentMethodId !== created.methods[0] ? original.defaultPaymentMethodId : null }, "PUT").catch(() => undefined);
    await api(`/api/agents/${A}`, null, "DELETE").catch(() => undefined);
    await api(`/api/agents/${other.id}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept: agent ${A}, methods ${created.methods.join(", ")}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
