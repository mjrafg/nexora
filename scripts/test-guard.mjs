#!/usr/bin/env node
/* ------------------------------------------------------------------
   Side-Effect Guard regression suite (spec §20–§28).
   Drives the Nexora Tool Runner through /api/tools/run with a mock MCP
   provider that counts real invocations (MOCK_LOG).

   Usage: node scripts/test-guard.mjs [baseUrl] [--keep]
   The mock server must be reachable from the app: this script registers
   it via the MCP API (stdio: node scripts/mock-sideeffect-mcp.mjs) and
   removes it at the end unless --keep is given.
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
// the mock provider writes here; on the server the data dir is outside the app directory
const MOCK_LOG = process.env.MOCK_LOG || path.join(process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data"), "mock-sideeffect-calls.jsonl");
let cookie = "";

async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${j.error ?? ""} ${j.detail ?? ""}`);
  return j;
}
const run = (agentId, tool, args, scopeId) => api("/api/tools/run", { agentId, tool, args, scopeId });
const calls = (tool) => (fs.existsSync(MOCK_LOG) ? fs.readFileSync(MOCK_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((c) => !tool || c.tool === tool);
const resetLog = () => { try { fs.unlinkSync(MOCK_LOG); } catch { /* none */ } };
const parse = (rec) => { try { return JSON.parse(rec.result); } catch { return null; } };

const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`✓ ${name}${note ? ` — ${note}` : ""}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`✗ ${name} — ${String(err.message || err).slice(0, 400)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---- setup: login, mock server, test agent with a grant
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
resetLog();
const server = (await api("/api/mcp-servers", { name: "Mock Sideeffect", config: { transport: "stdio", command: process.execPath, args: [path.join(process.cwd(), "scripts", "mock-sideeffect-mcp.mjs")], env: { MOCK_LOG } } })).server;
assert(server.tools.length === 4, `mock discovery failed: ${server.tools.length} tools`);
const SLUG = server.slug;
const agent = (await api("/api/agents", { name: "Guard Test Agent", role: "Test", dept: "engineering", toolPermissions: [], mcpGrants: [{ serverId: server.id, enabled: true, tools: "all" }] })).agent;
const A = agent.id;
const T = (name) => `${SLUG}__${name.toLowerCase()}`;
const email = { to: "a@example.com", subject: "Hello", body: "Test" };
const scopeA = `test:taskA:${Date.now()}`;
const scopeB = `test:taskB:${Date.now()}`;

try {
  await test("classification: sendEmail/purchase side-effecting, searchEmails read-only", async () => {
    const s = await run(A, T("searchEmails"), { query: "x" }, scopeA);
    assert(s.guard.outcome === "read_only" && s.guard.class === "READ_ONLY", JSON.stringify(s.guard));
    const e = await run(A, T("sendEmail"), { ...email, subject: "classify-probe" }, `probe:${Date.now()}`);
    assert(e.guard.class === "SIDE_EFFECT", JSON.stringify(e.guard));
    const p = await run(A, T("purchase"), { item: "probe", amountUsd: 1 }, `probe:${Date.now()}`);
    assert(p.guard.class === "FINANCIAL", JSON.stringify(p.guard));
    resetLog();
  });

  await test("§20 identical sendEmail twice in one scope → provider called once, second deduplicated", async () => {
    const first = await run(A, T("sendEmail"), email, scopeA);
    assert(first.ok && first.guard.outcome === "executed" && first.guard.status === "SUCCEEDED", JSON.stringify(first.guard));
    const second = await run(A, T("sendEmail"), { subject: "Hello", to: "a@example.com", body: "Test " }, scopeA); // reordered keys + trailing space
    assert(second.ok && second.guard.outcome === "deduplicated", JSON.stringify(second.guard));
    const payload = parse(second);
    assert(payload?.status === "already_completed" && payload.deduplicated === true && payload.executionId === first.guard.executionId, second.result);
    assert(/messageId/.test(payload.originalResult), "original result missing message id");
    assert(calls("sendEmail").length === 1, `provider calls: ${calls("sendEmail").length}`);
    return `ref ${first.guard.externalReference}`;
  });

  await test("§21 concurrent identical purchase($20) → one provider invocation, other reuses result", async () => {
    const scope = `test:concurrent:${Date.now()}`;
    const [a, b, c] = await Promise.all([
      run(A, T("purchase"), { item: "seat", amountUsd: 20 }, scope),
      run(A, T("purchase"), { item: "seat", amountUsd: 20 }, scope),
      run(A, T("purchase"), { item: "seat", amountUsd: 20 }, scope),
    ]);
    const outcomes = [a, b, c].map((r) => r.guard.outcome).sort();
    assert(outcomes.filter((o) => o === "executed").length === 1, `outcomes ${outcomes}`);
    assert(outcomes.every((o) => o === "executed" || o === "in_flight_reused" || o === "deduplicated"), `outcomes ${outcomes}`);
    assert(calls("purchase").length === 1, `provider calls: ${calls("purchase").length}`);
    const ids = new Set([a, b, c].map((r) => r.guard.executionId));
    assert(ids.size === 1, "all callers must share one execution id");
    return `outcomes ${outcomes.join(", ")}`;
  });

  await test("§22 same email in a different task scope → allowed", async () => {
    const r = await run(A, T("sendEmail"), email, scopeB);
    assert(r.ok && r.guard.outcome === "executed", JSON.stringify(r.guard));
    assert(calls("sendEmail").length === 2, `provider calls: ${calls("sendEmail").length}`);
  });

  await test("§23 different arguments in the same scope → both execute", async () => {
    const r1 = await run(A, T("sendEmail"), { to: "b@example.com", subject: "Other", body: "B" }, scopeA);
    const r2 = await run(A, T("sendEmail"), { to: "c@example.com", subject: "Third", body: "C" }, scopeA);
    assert(r1.guard.outcome === "executed" && r2.guard.outcome === "executed", `${r1.guard.outcome} ${r2.guard.outcome}`);
    assert(calls("sendEmail").length === 4, `provider calls: ${calls("sendEmail").length}`);
  });

  await test("§24 confirmed failure → FAILED, retry allowed and executes", async () => {
    const scope = `test:fail:${Date.now()}`;
    const f = await run(A, T("sendEmail"), { ...email, mode: "fail" }, scope);
    assert(!f.ok && f.guard.status === "FAILED", JSON.stringify(f.guard));
    const retry = await run(A, T("sendEmail"), { ...email, mode: "fail" }, scope);
    assert(retry.guard.outcome === "executed" && retry.guard.attempt === 2, JSON.stringify(retry.guard));
    const ok = await run(A, T("sendEmail"), { ...email }, scope);
    assert(ok.ok && ok.guard.outcome === "executed", JSON.stringify(ok.guard));
  });

  await test("§25 uncertain outcome (provider hangs → timeout) → UNCERTAIN, identical retry blocked with verify guidance", async () => {
    const scope = `test:uncertain:${Date.now()}`;
    const before = calls("sendEmail").length;
    const h = await run(A, T("sendEmail"), { ...email, mode: "hang" }, scope);
    assert(!h.ok && h.guard.status === "UNCERTAIN", JSON.stringify(h.guard) + " " + h.error);
    assert(/uncertain_outcome/.test(h.error), h.error);
    const again = await run(A, T("sendEmail"), { ...email, mode: "hang" }, scope);
    assert(again.guard.outcome === "uncertain_blocked", JSON.stringify(again.guard));
    const payload = parse(again);
    assert(payload?.status === "uncertain_outcome" && /verify/i.test(payload.message), again.result);
    assert(calls("sendEmail").length === before + 1, `provider must see exactly one attempt (saw ${calls("sendEmail").length - before})`);
    // read-only verification still works freely
    const v = await run(A, T("searchEmails"), { query: "Hello" }, scope);
    assert(v.ok && v.guard.outcome === "read_only", JSON.stringify(v.guard));
    return "60 s client timeout observed";
  });

  await test("§26 financial safety: identical purchase twice → one provider invocation", async () => {
    const scope = `test:fin:${Date.now()}`;
    const before = calls("purchase").length;
    const a = await run(A, T("purchase"), { item: "domain", amountUsd: 20 }, scope);
    const b = await run(A, T("purchase"), { item: "domain", amountUsd: 20 }, scope);
    assert(a.guard.outcome === "executed" && b.guard.outcome === "deduplicated", `${a.guard.outcome} ${b.guard.outcome}`);
    assert(a.guard.class === "FINANCIAL", a.guard.class);
    assert(calls("purchase").length === before + 1, `provider calls: ${calls("purchase").length - before}`);
  });

  await test("§27 read-only tool repeats normally (no dedup)", async () => {
    const scope = `test:read:${Date.now()}`;
    const before = calls("searchEmails").length;
    for (let i = 0; i < 3; i++) {
      const r = await run(A, T("searchEmails"), { query: "same" }, scope);
      assert(r.ok && r.guard.outcome === "read_only", JSON.stringify(r.guard));
    }
    assert(calls("searchEmails").length === before + 3, `provider calls: ${calls("searchEmails").length - before}`);
  });

  await test("§10 provider idempotency key forwarded when the tool declares one", async () => {
    const scope = `test:idem:${Date.now()}`;
    const r = await run(A, T("createRecord"), { name: "widget" }, scope);
    assert(r.ok && r.guard.providerIdempotency === true, JSON.stringify(r.guard));
    const seen = calls("createRecord").at(-1);
    assert(seen && typeof seen.args.idempotencyKey === "string" && seen.args.idempotencyKey.startsWith("nx-"), JSON.stringify(seen));
    return seen.args.idempotencyKey;
  });

  await test("§14 intentional repeat via start_new_action_attempt (audited) → executes again", async () => {
    const scope = `test:repeat:${Date.now()}`;
    const a = await run(A, T("sendEmail"), email, scope);
    const dup = await run(A, T("sendEmail"), email, scope);
    assert(a.guard.outcome === "executed" && dup.guard.outcome === "deduplicated", `${a.guard.outcome} ${dup.guard.outcome}`);
    const bump = await run(A, "nexora__start_new_action_attempt", { reason: "Customer explicitly asked for the same message to be resent" }, scope);
    assert(bump.ok && /attempt #1/.test(bump.result), bump.result);
    const again = await run(A, T("sendEmail"), email, scope);
    assert(again.guard.outcome === "executed", JSON.stringify(again.guard));
    const third = await run(A, T("sendEmail"), email, scope);
    assert(third.guard.outcome === "deduplicated", JSON.stringify(third.guard));
  });

  await test("§28 ledger persisted on disk (survives a process restart)", async () => {
    const ledger = JSON.parse(fs.readFileSync(path.join(process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data"), "actions.json"), "utf8"));
    const rows = ledger.executions.filter((e) => e.scopeId === scopeA && e.toolName === "sendEmail");
    assert(rows.some((e) => e.status === "SUCCEEDED" && e.externalReference), "no persisted SUCCEEDED row for scope A");
    assert(!JSON.stringify(ledger).includes(PASS), "ledger must not contain secrets");
    const audit = await api(`/api/actions?scopeId=${encodeURIComponent(scopeA)}`);
    assert(audit.executions.length >= 3, `audit rows ${audit.executions.length}`);
    return `${rows.length} rows for scope A; restart check: run with --restart-check <scopeId> after restarting`;
  });

  await test("§18 no secrets in ledger arg summaries", async () => {
    const audit = await api(`/api/actions?limit=1000`);
    const blob = JSON.stringify(audit);
    assert(!blob.includes(PASS) && !/sk-[a-z0-9]{10,}/i.test(blob), "secret-looking value in ledger");
  });
} finally {
  if (!KEEP) {
    await api(`/api/agents/${A}`, null, "DELETE").catch(() => undefined);
    await api(`/api/mcp-servers/${server.id}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept: agent ${A}, server ${server.id} (${SLUG}), scopeA=${scopeA}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
