#!/usr/bin/env node
/* ------------------------------------------------------------------
   Credential Manager regression suite (spec §36–§42) — API + Tool Runner
   level, driving the real browser host through the agent's own session.
   Usage: node scripts/test-credentials.mjs [baseUrl] [--keep]
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
const refOf = (snapshotText, label) => {
  // Playwright aria snapshot lines look like: - textbox "Email" [ref=e12]
  const re = new RegExp(`[^\\n]*"${label}"[^\\n]*\\[ref=([a-z0-9]+)\\]`, "i");
  const m = snapshotText.match(re);
  return m ? m[1] : null;
};

const PW_OK = "Correct-Horse-Battery-9";
const PW_ADS = "Globex-Ads-Pass-42";

// ---- setup
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const agent = (await api("/api/agents", { name: "Credential Test Agent", role: "Test", dept: "engineering", toolPermissions: ["browser", "credentials"] })).agent;
const manager = (await api("/api/agents", { name: "Credential Manager Test Agent", role: "Test", dept: "engineering", toolPermissions: ["browser", "credentials", "credentials_manage"] })).agent;
const A = agent.id;
const created = [];
const mk = async (body) => { const c = (await api("/api/logins", body)).credential; created.push(c.id); return c; };
const scope = `test:cred:${Date.now()}`;

try {
  await test("§2/§5 owner adds credentials; list is masked; vault holds the password", async () => {
    const acme = await mk({ name: "Acme Cloud — Test", service: "Acme Cloud", site: "localhost:3111/mock-login.html", loginUrl: `${BASE}/mock-login.html`, description: "Acme Cloud console account used by the test suite to sign in to the Acme Cloud dashboard.", username: "tester@example.com", password: PW_OK });
    await mk({ name: "Globex Ads — Test", service: "Globex", site: "localhost:3111/mock-login-steps.html", loginUrl: `${BASE}/mock-login-steps.html`, description: "Globex Ads advertising account used to manage ad campaigns and billing on the Globex Ads dashboard.", username: "ads@example.com", password: PW_ADS });
    await mk({ name: "Globex Cloud — Test", service: "Globex", site: "cloud.globex.example", loginUrl: "https://cloud.globex.example/", description: "Globex Cloud infrastructure console for servers and storage — not for advertising.", username: "ops@example.com", password: "other-pass-1" });
    await mk({ name: "Globex Mail — Test", service: "Globex", site: "mail.globex.example", description: "Globex webmail mailbox for the ops team; reading and sending email only.", username: "mail@example.com", password: "other-pass-2" });
    assert(acme.usernameMasked === "t••••@example.com" && !("username" in acme) && !JSON.stringify(acme).includes(PW_OK), JSON.stringify(acme));
    const list = await api("/api/logins");
    assert(list.credentials.length >= 4 && !JSON.stringify(list).includes(PW_OK) && !JSON.stringify(list).includes(PW_ADS), "list leaks");
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    assert(!JSON.stringify(db.loginCredentials).includes(PW_OK) && !JSON.stringify(db).includes(PW_OK), "raw password on disk");
    const vault = await api("/api/credentials");
    assert(!vault.credentials.some((c) => c.name.startsWith("login:")), "login secret visible in the MCP vault list");
  });

  await test("§6 list_credentials tool returns safe metadata only; description present", async () => {
    const r = await run(A, "credentials__list_credentials", {}, scope);
    assert(r.ok && r.guard.outcome === "read_only", JSON.stringify(r.guard) + r.error);
    const rows = JSON.parse(r.result);
    assert(rows.length >= 4 && rows.every((x) => x.username_masked && x.description && x.site && !("password" in x)), r.result.slice(0, 300));
    assert(!r.result.includes(PW_OK), "password in list");
  });

  await test("§34 agent without credentials_manage cannot save/generate", async () => {
    const r = await run(A, "credentials__generate_password", {}, scope);
    assert(!r.ok && /not permitted|may use credentials/i.test(r.error), r.error ?? r.result);
  });

  await test("§36 existing credential: navigate, insert username+password (insert_credentials), sign in — no secret in results/activity", async () => {
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-login.html` }, scope);
    assert(nav.ok, nav.error);
    const email = refOf(nav.result, "Email"); const pw = refOf(nav.result, "Password");
    assert(email && pw, "refs not found in snapshot: " + nav.result.slice(0, 400));
    const acme = created[0];
    const ins = await run(A, "credentials__insert_credentials", { credential_id: acme, fields: { username: email, password: pw } }, scope);
    assert(ins.ok, ins.error);
    const out = JSON.parse(ins.result);
    assert(out.success && out.fields_filled.join(",") === "username,password" && !ins.result.includes(PW_OK) && !ins.result.includes("tester@example.com"), ins.result);
    const btn = refOf(nav.result, "Sign in");
    const click = await run(A, "browser__browser_click", { ref: btn, element: "Sign in" }, scope);
    assert(click.ok && /Dashboard/.test(click.result), click.result);
    const read = await run(A, "browser__browser_read", {}, scope);
    assert(/Welcome back, tester/.test(read.result), read.result.slice(0, 200));
    const msgs = await api(`/api/agents/${A}/messages`); void msgs;
    const ledger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "actions.json"), "utf8"));
    assert(!JSON.stringify(ledger).includes(PW_OK), "password in ledger");
    const logins = await api("/api/logins");
    const used = logins.credentials.find((c) => c.id === acme);
    assert(used.useCount >= 1 && used.lastUsedBy === A, "usage not recorded");
    assert(logins.activity.some((a) => a.kind === "used" && a.text.includes("Acme Cloud — Test")), "activity missing");
    assert(!JSON.stringify(logins.activity).includes(PW_OK), "activity leaks");
  });

  await test("§41 multi-step login: username → Next → password → Next (insert_credential_field twice)", async () => {
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-login-steps.html` }, scope);
    const idRef = refOf(nav.result, "Email or phone");
    assert(idRef, "identifier ref missing: " + nav.result.slice(0, 300));
    const ads = created[1];
    const one = await run(A, "credentials__insert_credential_field", { credential_id: ads, field: "username", target: idRef }, scope);
    assert(one.ok && JSON.parse(one.result).success && !one.result.includes("ads@example.com"), one.error ?? one.result);
    const next1 = await run(A, "browser__browser_click", { ref: refOf(nav.result, "Next"), element: "Next" }, scope);
    assert(next1.ok, next1.error);
    const snap = await run(A, "browser__browser_snapshot", {}, scope);
    const pwRef = refOf(snap.result, "Enter your password");
    assert(pwRef, "password ref missing: " + snap.result.slice(0, 300));
    const two = await run(A, "credentials__insert_credential_field", { credential_id: ads, field: "password", target: pwRef }, scope);
    assert(two.ok && !two.result.includes(PW_ADS), two.error ?? two.result);
    const next2 = await run(A, "browser__browser_click", { ref: refOf(snap.result, "Next"), element: "Next" }, scope);
    assert(next2.ok && /Dashboard/.test(next2.result), next2.result);
  });

  await test("§40 invalid saved password: site error is readable; tools never return the secret", async () => {
    const bad = await mk({ name: "Acme Cloud — Stale", service: "Acme Cloud", site: "localhost:3111/mock-login.html", loginUrl: `${BASE}/mock-login.html`, description: "Old Acme Cloud console login kept for the failure test; the password is outdated.", username: "tester@example.com", password: "wrong-password-000" });
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-login.html` }, scope);
    const ins = await run(A, "credentials__insert_credentials", { credential_id: bad.id, fields: { username: refOf(nav.result, "Email"), password: refOf(nav.result, "Password") } }, scope);
    assert(ins.ok && !ins.result.includes("wrong-password-000"), `insert failed: ${ins.error ?? ins.result} (refs ${refOf(nav.result, "Email")}/${refOf(nav.result, "Password")}) snapshot: ${nav.result.slice(0, 300)}`);
    const click = await run(A, "browser__browser_click", { ref: refOf(nav.result, "Sign in"), element: "Sign in" }, scope);
    assert(/failed/.test(click.result), click.result);
    const read = await run(A, "browser__browser_read", {}, scope);
    assert(/Wrong email or password/.test(read.result), read.result.slice(0, 200));
  });

  await test("§18 update_credential rotates the password (manager agent), old one not exposed", async () => {
    const bad = created[created.length - 1];
    const u = await run(manager.id, "credentials__update_credential", { credential_id: bad, password: PW_OK, description: "Acme Cloud console login (rotated by the test suite) used to sign in to the dashboard." }, scope);
    assert(u.ok && !u.result.includes(PW_OK) && !u.result.includes("wrong-password-000"), u.error ?? u.result);
    assert(u.args.password === "•••", "password arg not masked in tool record: " + JSON.stringify(u.args));
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-login.html` }, scope);
    await run(A, "credentials__insert_credentials", { credential_id: bad, fields: { username: refOf(nav.result, "Email"), password: refOf(nav.result, "Password") } }, scope);
    const click = await run(A, "browser__browser_click", { ref: refOf(nav.result, "Sign in"), element: "Sign in" }, scope);
    assert(/Dashboard/.test(click.result), click.result);
  });

  await test("§15/§16 generate_password is sensitive; save_credential stores with description; appears in list", async () => {
    const g = await run(manager.id, "credentials__generate_password", { length: 20 }, scope);
    assert(g.ok && g.sensitive === true && /Generated password/.test(g.result), g.error ?? g.result);
    const pw = g.result.split(": ").pop().trim();
    assert(pw.length === 20 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw), "weak password " + pw);
    const weak = await run(manager.id, "credentials__save_credential", { name: "Initech — Test", service: "Initech", site: "initech.example", description: "Initech", username: "x@example.com", password: pw }, scope);
    assert(!weak.ok && /description/.test(weak.error), "short description accepted");
    const s = await run(manager.id, "credentials__save_credential", { name: "Initech Notes — Test", service: "Initech", site: "notes.initech.example", login_url: "https://notes.initech.example/login", description: "Initech Notes workspace created by the test suite for shared team notes and documents.", username: "notes@example.com", password: pw }, scope);
    assert(s.ok && !s.result.includes(pw), s.error ?? s.result);
    const id = JSON.parse(s.result).credential_id; created.push(id);
    const list = JSON.parse((await run(A, "credentials__list_credentials", {}, scope)).result);
    const row = list.find((x) => x.id === id);
    assert(row && row.description.includes("Initech Notes") && row.username_masked === "n••••@example.com", JSON.stringify(row));
    const acts = (await api("/api/logins")).activity;
    assert(!JSON.stringify(acts).includes(pw), "generated password leaked into activity");
  });

  await test("§20–§23 request_credential → owner adds via UI API → RESOLVED, agent flagged waiting then resumed", async () => {
    const r = await run(A, "credentials__request_credential", { service: "Hooli", site: "app.hooli.example", login_url: "https://app.hooli.example/login", reason: "Need the existing company Hooli account; cannot self-register (invite only)." }, scope);
    assert(r.ok && /resumed automatically/.test(r.result), r.error ?? r.result);
    const reqs = (await api("/api/logins")).requests.filter((x) => x.status === "WAITING" && x.service === "Hooli");
    assert(reqs.length === 1, "request missing");
    const ag = (await api(`/api/agents/${A}`)).agent;
    // the waiting state is typed and points at the Credentials surface, not "capability"
    assert(ag.waiting && ag.waiting.kind === "credential" && ag.waiting.requestId === reqs[0].id, `agent not flagged waiting: ${JSON.stringify(ag.waiting)}`);
    assert(ag.waiting.surface === "Credentials" && ag.waiting.href === `/credentials?request=${reqs[0].id}`, JSON.stringify(ag.waiting));
    const saved = await api("/api/logins", { name: "Hooli — Test", service: "Hooli", site: "app.hooli.example", loginUrl: "https://app.hooli.example/login", description: "Company Hooli workspace account used for the Hooli app dashboard and reports.", username: "team@example.com", password: "Hooli-Pass-77", requestId: reqs[0].id });
    created.push(saved.credential.id);
    assert(saved.request && saved.request.status === "RESOLVED" && saved.request.resolvedCredentialId === saved.credential.id, JSON.stringify(saved.request));
    const ag2 = (await api(`/api/agents/${A}`)).agent;
    assert(!ag2.waiting, "waiting flag not cleared");
    // the resume is a real system message to the agent; wait briefly for it to be recorded
    let msgs = [];
    for (let i = 0; i < 120; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /credential request .* RESOLVED/i.test(m.content))) break; await new Promise((x) => setTimeout(x, 1000)); }
    assert(msgs.some((m) => m.origin === "system" && /RESOLVED/.test(m.content)), "resume message not sent");
    assert(!JSON.stringify(msgs).includes("Hooli-Pass-77"), "password leaked into transcript");
    return "resume message delivered in the requester's conversation";
  });

  await test("§19 owner can disable and delete; disabled credential cannot be inserted", async () => {
    const acme = created[0];
    await api(`/api/logins/${acme}`, { status: "DISABLED" }, "PATCH");
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-login.html` }, scope);
    const ins = await run(A, "credentials__insert_credential_field", { credential_id: acme, field: "username", target: refOf(nav.result, "Email") }, scope);
    assert(!ins.ok && /disabled/i.test(ins.error), ins.error ?? ins.result);
    await api(`/api/logins/${acme}`, { status: "AVAILABLE" }, "PATCH");
  });
  await test("§20 a DISMISSED credential request reaches the agent instead of leaving it parked", async () => {
    const ask = await run(A, "credentials__request_credential", {
      service: "Dismissed Portal", site: "dismissed.example", login_url: "https://dismissed.example/login",
      reason: "This request exists so that dismissing it can be checked.",
    }, scope);
    assert(ask.ok, ask.error);
    const parked = (await api(`/api/agents/${A}`)).agent;
    assert(parked.waiting?.kind === "credential", JSON.stringify(parked.waiting));
    const reqId = parked.waiting.requestId;
    const before = (await api(`/api/agents/${A}/messages`)).messages.length;
    await api(`/api/logins/requests/${reqId}/cancel`, {});
    let told = null;
    for (let i = 0; i < 40; i++) {
      const msgs = (await api(`/api/agents/${A}/messages`)).messages;
      told = msgs.slice(before).find((m) => m.origin === "system" && /DISMISSED/.test(m.content ?? ""));
      if (told) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert(told, "the owner dismissed the request and the agent was never told");
    assert(/Dismissed Portal/.test(told.content), told.content.slice(0, 120));
    assert(!(await api(`/api/agents/${A}`)).agent.waiting, "still parked after the dismissal");
    return "told, and released";
  });

} finally {
  await run(A, "browser__browser_kill", {}, scope).catch(() => undefined);
  await api("/api/browser/sessions", { id: `agent:${A}`, action: "delete" }).catch(() => undefined);
  if (!KEEP) {
    for (const id of created) await api(`/api/logins/${id}`, null, "DELETE").catch(() => undefined);
    await api(`/api/agents/${A}`, null, "DELETE").catch(() => undefined);
    await api(`/api/agents/${manager.id}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept: agent ${A}, manager ${manager.id}, credentials ${created.join(", ")}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
