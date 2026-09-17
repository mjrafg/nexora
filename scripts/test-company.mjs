#!/usr/bin/env node
/* ------------------------------------------------------------------
   Company Profile regression suite (spec §25–§30) — API + Tool Runner
   level, driving the real browser host for the signup flows.
   Usage: node scripts/test-company.mjs [baseUrl] [--keep]
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
  const re = new RegExp(`[^\\n]*"${label}[^"\\n]*"[^\\n]*\\[ref=([a-z0-9]+)\\]`, "i");
  const m = snapshotText.match(re);
  return m ? m[1] : null;
};
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));

const TAX_ID = "12-3456789";
const PROFILE = {
  name: "Agent24 Test Co", legalName: "Agent24 Test Co LLC", entityType: "LLC", industry: "AI / Software / SaaS",
  ownerFirstName: "Test", ownerLastName: "Owner", ownerTitle: "Managing Member",
  website: "https://test.agent24.io", description: "Agent24 Test Co builds autonomous AI teams for the Nexora regression suite.",
  timezone: "America/New_York",
  address: { line1: "500 Congress Ave", line2: "Suite 200", city: "Boston", region: "Massachusetts", postalCode: "02110", country: "United States" },
};

// ---- setup
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const original = (await api("/api/company")).profile;
assert(!original.name && !original.contacts.length, `The company profile already has data (name "${original.name}", ${original.contacts.length} contacts) — this suite would overwrite it. Clear it first or run against a test install.`);
const conns = (await api("/api/providers").catch(() => ({ connections: [] }))).connections ?? [];
const dead = conns.find((c) => c.status !== "connected");
const runtime = dead ? { runtimeType: "api", providerConnectionId: dead.id, model: "test-model-does-not-exist" } : undefined;
const mkAgent = async (name, toolPermissions) => (await api("/api/agents", { name, role: "Test", dept: "engineering", toolPermissions, runtime })).agent;
const agent = await mkAgent("Company Test Agent", ["browser", "company_profile"]);
const plain = await mkAgent("No-Company Agent", ["browser"]);
const writer = await mkAgent("Company Writer Agent", ["browser", "company_profile", "company_profile_manage"]);
const A = agent.id;
const scope = `test:company:${Date.now()}`;
const created = { contacts: [] };

try {
  await test("§25 TEST A — owner fills the profile; get_company_profile returns exactly it and invents nothing", async () => {
    const r = await api("/api/company", PROFILE, "PATCH");
    assert(r.profile.name === PROFILE.name && r.profile.website === PROFILE.website && r.profile.address.city === "Boston", JSON.stringify(r.profile).slice(0, 300));
    const c1 = (await api("/api/company/contacts", { type: "EMAIL", name: "Primary Company Email", value: "company@test.agent24.io", description: "General company email used for registrations, external services and company accounts.", isPrimary: true })).contact;
    const c2 = (await api("/api/company/contacts", { type: "PHONE", name: "Company Phone", value: "+1 617 555 0142", description: "Primary Agent24 company mobile number. Use for business registrations and SMS verification.", isPrimary: true })).contact;
    created.contacts.push(c1.id, c2.id);
    const t = await run(A, "company__get_company_profile", {}, scope);
    assert(t.ok && t.guard.outcome === "read_only", JSON.stringify(t.guard) + (t.error ?? ""));
    const p = parse(t);
    assert(p.name === PROFILE.name && p.legal_name === PROFILE.legalName && p.entity_type === "LLC" && p.industry === PROFILE.industry && p.website === PROFILE.website && p.timezone === "America/New_York", t.result.slice(0, 400));
    assert(p.address.city === "Boston" && p.address.state === "Massachusetts" && p.address.postal_code === "02110" && p.address.country === "United States", JSON.stringify(p.address));
    assert(p.owner.first_name === "Test" && p.owner.last_name === "Owner" && p.owner.full_name === "Test Owner" && p.owner.title === "Managing Member", JSON.stringify(p.owner));
    assert(p.contacts.length === 2 && p.contacts.find((c) => c.type === "EMAIL").value === "company@test.agent24.io" && p.contacts.find((c) => c.type === "PHONE").value === "+1 617 555 0142", JSON.stringify(p.contacts));
    // nothing invented: fields the owner never entered are absent and reported as missing
    assert(!p.legal || !p.legal.tax_id, "tax id invented");
    assert(Array.isArray(p.missing) && p.missing.includes("legal.tax_id") && p.missing.includes("legal.registration_number"), JSON.stringify(p.missing));
    const single = parse(await run(A, "company__get_company_info", { fields: ["name", "website", "owner_name", "primary_email", "primary_phone", "legal.registration_number"] }, scope));
    assert(single.name === PROFILE.name && single.owner_name === "Test Owner" && single.primary_email === "company@test.agent24.io" && single.missing.includes("legal.registration_number") && !("legal.registration_number" in single), JSON.stringify(single));
    return "profile + 2 contacts returned verbatim, 0 invented values";
  });

  await test("§12 permissions — an agent without the company permission has no company tools; no agent tool can write", async () => {
    const r = await run(plain.id, "company__get_company_profile", {}, scope);
    assert(!r.ok && /Unknown or not permitted/i.test(r.error), r.error ?? r.result);
    const tools = (await api(`/api/agents/${A}`)).agent;
    void tools;
    // read-only agent: the write tools exist on the server but are refused for it
    for (const [t, args] of [["company__update_company_profile", { name: "Hacked", reason: "test" }], ["company__add_company_contact", { type: "EMAIL", name: "x", value: "x@example.com", description: "should be refused", reason: "test" }]]) {
      const w = await run(A, t, args, scope);
      assert(!w.ok && /may read the company profile but not change it|not permitted/i.test(w.error), `${t}: ${w.error ?? w.result}`);
    }
    assert((await api("/api/company")).profile.name === PROFILE.name, "profile changed");
  });

  await test("§26 TEST B — with three emails the agent picks by description, not by position", async () => {
    for (const c of [
      { type: "EMAIL", name: "Sales", value: "sales@test.agent24.io", description: "Use for sales, customer acquisition and commercial communication with prospects." },
      { type: "EMAIL", name: "Support", value: "support@test.agent24.io", description: "Use for customer support and customer-service communication only." },
    ]) created.contacts.push((await api("/api/company/contacts", c)).contact.id);
    const p = parse(await run(A, "company__get_company_profile", {}, scope));
    const emails = p.contacts.filter((c) => c.type === "EMAIL");
    assert(emails.length === 3 && emails.every((c) => c.description && c.name), JSON.stringify(emails));
    // the data an LLM needs to choose is present and unambiguous: exactly one is primary and each says what it is for
    const primary = emails.filter((c) => c.is_primary);
    assert(primary.length === 1 && primary[0].value === "company@test.agent24.io", JSON.stringify(primary));
    assert(emails.find((c) => c.value.startsWith("sales")).description.includes("sales") && emails.find((c) => c.value.startsWith("support")).description.includes("support"), "descriptions lost");
    const info = parse(await run(A, "company__get_company_info", { fields: ["contacts"] }, scope));
    assert(info.contacts.length === 4, JSON.stringify(info));
    return "3 emails + 1 phone, one primary, all with purpose descriptions";
  });

  let req;
  await test("§27 TEST C — missing legal field: agent does not invent it, creates an owner request and is flagged waiting", async () => {
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-vendor-registry.html` }, scope);
    assert(nav.ok && /registration number/i.test(nav.result), nav.error ?? nav.result.slice(0, 200));
    const before = parse(await run(A, "company__get_company_info", { fields: ["legal.registration_number"] }, scope));
    assert(before.missing.includes("legal.registration_number") && !before["legal.registration_number"], JSON.stringify(before));
    const r = await run(A, "company__request_company_info", { field: "legal.registration_number", needed_by: "Vendor registry supplier registration", reason: "The registry rejects the form without the company's legal registration number." }, scope);
    assert(r.ok && /resumed automatically/i.test(r.result), r.error ?? r.result);
    const reqs = (await api("/api/company")).requests.filter((x) => x.status === "WAITING");
    req = reqs.find((x) => x.field === "legal.registration_number");
    assert(req && req.requesterAgentId === A && req.label === "Registration number" && req.neededBy.includes("Vendor registry"), JSON.stringify(reqs));
    const a = (await api(`/api/agents/${A}`)).agent;
    assert(a.waiting && a.waiting.kind === "company" && a.waiting.requestId === req.id && a.waiting.href === `/company?request=${req.id}`, JSON.stringify(a.waiting));
    const again = await run(A, "company__request_company_info", { field: "legal.registration_number", needed_by: "same form", reason: "duplicate" }, `${scope}:dup`);
    assert(again.ok && (await api("/api/company")).requests.filter((x) => x.status === "WAITING" && x.field === "legal.registration_number").length === 1, "duplicate request created");
    const act = (await api("/api/company")).activity;
    assert(act.some((x) => x.kind === "info_requested" && x.text.includes("Registration number")), "activity missing");
    return `request #${req.id.slice(0, 8)} waiting`;
  });

  await test("§16 owner fills the field → request RESOLVED automatically → requester resumed in its scope", async () => {
    await api("/api/company", { legal: { registrationNumber: "MA-778-2231" } }, "PATCH");
    const after = (await api("/api/company")).requests.find((x) => x.id === req.id);
    assert(after.status === "RESOLVED" && after.resolvedAt, JSON.stringify(after));
    const a = (await api(`/api/agents/${A}`)).agent;
    assert(!a.waiting, JSON.stringify(a.waiting));
    let msgs = [];
    for (let i = 0; i < 120; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /RESOLVED/.test(m.content) && /Registration number/.test(m.content))) break; await sleep(1000); }
    assert(msgs.some((m) => m.origin === "system" && /RESOLVED/.test(m.content)), "resume message not delivered");
    const p = parse(await run(A, "company__get_company_info", { fields: ["legal.registration_number"] }, scope));
    assert(p["legal.registration_number"] === "MA-778-2231" && !p.missing, JSON.stringify(p));
    const blocked = await run(A, "company__request_company_info", { field: "legal.registration_number", needed_by: "again", reason: "should refuse" }, `${scope}:after`);
    assert(!blocked.ok && /already in the Company Profile/i.test(blocked.error), blocked.error ?? blocked.result);
    return "auto-resolved on save, agent resumed, re-request refused";
  });

  await test("§28 TEST D — billing address follows the company address, then diverges", async () => {
    let p = parse(await run(A, "company__get_company_profile", {}, scope));
    assert(p.billing_address.city === "Boston" && p.billing_address_same_as_company === true, JSON.stringify(p.billing_address));
    await api("/api/company", { billingSameAsCompany: false, billingAddress: { line1: "1 Billing Plaza", city: "Cambridge", region: "Massachusetts", postalCode: "02142", country: "United States" } }, "PATCH");
    p = parse(await run(A, "company__get_company_profile", {}, scope));
    assert(p.billing_address.city === "Cambridge" && p.billing_address.line1 === "1 Billing Plaza" && !p.billing_address_same_as_company && p.address.city === "Boston", JSON.stringify({ b: p.billing_address, a: p.address }));
    await api("/api/company", { billingSameAsCompany: true }, "PATCH");
    p = parse(await run(A, "company__get_company_profile", {}, scope));
    assert(p.billing_address.city === "Boston", JSON.stringify(p.billing_address));
    return "same-as → separate → same-as, resolved correctly each time";
  });

  await test("§8/§21 legal data: EIN normalised and masked in the UI, never in activity, available to the agent", async () => {
    await api("/api/company", { legal: { taxId: "123456789", registrationState: "Massachusetts", registrationCountry: "United States", formationDate: "2025-03-14" } }, "PATCH");
    const view = (await api("/api/company")).profile;
    assert(view.legal.hasTaxId && /^•+6789$/.test(view.legal.taxIdMasked), `EIN not masked: ${JSON.stringify(view.legal)}`);
    assert(view.legal.taxId === undefined, "raw EIN returned to the normal UI view");
    const revealed = (await api("/api/company?reveal=taxId")).profile;
    assert(revealed.legal.taxId === TAX_ID, `EIN not normalised: ${revealed.legal.taxId}`);
    const act = (await api("/api/company")).activity;
    assert(!JSON.stringify(act).includes(TAX_ID) && !JSON.stringify(act).includes("123456789"), "EIN in activity");
    const p = parse(await run(A, "company__get_company_profile", {}, scope));
    assert(p.legal.tax_id === TAX_ID && p.legal.formation_date === "2025-03-14", JSON.stringify(p.legal));
    const bad = await api("/api/company", { legal: { taxId: "12-345" } }, "PATCH").catch((e) => e);
    assert(bad instanceof Error && /9 digits/.test(bad.message), "invalid EIN accepted");
    return `stored ${TAX_ID}, shown as ${view.legal.taxIdMasked}`;
  });

  await test("§20 validation catches obvious errors without blocking international values", async () => {
    for (const [body, needle] of [
      [{ website: "not a website" }, /website/i],
      [{ timezone: "Mars/Olympus" }, /timezone/i],
      [{ legal: { formationDate: "14/03/2025" } }, /YYYY-MM-DD/],
    ]) {
      const e = await api("/api/company", body, "PATCH").catch((x) => x);
      assert(e instanceof Error && needle.test(e.message), `accepted ${JSON.stringify(body)}`);
    }
    for (const [body, needle] of [
      [{ type: "EMAIL", name: "Bad", value: "not-an-email", description: "description long enough" }, /email/i],
      [{ type: "PHONE", name: "Bad", value: "12", description: "description long enough" }, /phone/i],
      [{ type: "EMAIL", name: "Bad", value: "ok@example.com", description: "short" }, /at least 10/i],
    ]) {
      const e = await api("/api/company/contacts", body).catch((x) => x);
      assert(e instanceof Error && needle.test(e.message), `accepted ${JSON.stringify(body)}`);
    }
    const intl = (await api("/api/company/contacts", { type: "PHONE", name: "EU Office", value: "+49 30 901820", description: "Berlin office line for European vendor registrations." })).contact;
    created.contacts.push(intl.id);
    const okWeb = await api("/api/company", { website: "test.agent24.io" }, "PATCH");
    assert(okWeb.profile.website === "https://test.agent24.io", okWeb.profile.website);
    return "bad values rejected, +49 number and scheme-less domain accepted";
  });

  await test("§29 TEST E — realistic signup: agent reads the profile and fills every field from it, inventing nothing", async () => {
    const p = parse(await run(A, "company__get_company_profile", {}, scope));
    const nav = await run(A, "browser__browser_navigate", { url: `${BASE}/mock-business-signup.html` }, scope);
    assert(nav.ok, nav.error);
    const email = p.contacts.find((c) => c.type === "EMAIL" && c.is_primary).value;
    const phone = p.contacts.find((c) => c.type === "PHONE" && c.is_primary).value;
    const fills = [
      ["Company name", p.name], ["Company website", p.website], ["Business email", email], ["Business phone", phone],
      ["Industry", p.industry], ["Street address", p.address.line1], ["City", p.address.city], ["State / Region", p.address.state],
      ["ZIP / Postal code", p.address.postal_code], ["Country", p.address.country],
    ];
    for (const [label, value] of fills) {
      assert(value, `no value for ${label} — the agent would have to invent it`);
      const ref = refOf(nav.result, label);
      assert(ref, `ref missing for ${label}: ${nav.result.slice(0, 300)}`);
      const t = await run(A, "browser__browser_type", { ref, text: value, element: label }, scope);
      assert(t.ok, `${label}: ${t.error}`);
    }
    const click = await run(A, "browser__browser_click", { ref: refOf(nav.result, "Create business account"), element: "Create business account" }, scope);
    assert(click.ok && /created/i.test(click.result), click.result.slice(0, 300));
    const read = await run(A, "browser__browser_read", {}, scope);
    assert(read.result.includes(PROFILE.name) && read.result.includes("company@test.agent24.io"), read.result.slice(0, 300));
    const open = (await api("/api/company")).requests.filter((r) => r.status === "WAITING");
    assert(open.length === 0, `agent asked the owner unnecessarily: ${JSON.stringify(open)}`);
    return "10 fields filled from the profile, no owner request needed";
  });

  await test("authorized agent updates the profile programmatically; audited with its name and reason", async () => {
    const wScope = `${scope}:w1`;
    const r = await run(writer.id, "company__update_company_profile", { reason: "The owner confirmed the new suite number and support site in chat.", description: "Agent24 Test Co runs autonomous AI operations teams for small businesses.", address: { line2: "Suite 410" }, timezone: "America/Chicago", owner_title: "Owner" }, wScope);
    assert(r.ok, r.error);
    const out = parse(r);
    assert(out.success && out.profile.timezone === "America/Chicago" && out.profile.address.line2 === "Suite 410" && out.profile.owner.title === "Owner" && out.profile.owner.full_name === "Test Owner", r.result.slice(0, 300));
    // merged, not replaced: the rest of the address survived an agent write
    assert(out.profile.address.city === "Boston" && out.profile.address.line1 === "500 Congress Ave" && out.profile.address.postal_code === "02110", JSON.stringify(out.profile.address));
    const view = (await api("/api/company")).profile;
    assert(view.updatedBy === writer.id && view.timezone === "America/Chicago", JSON.stringify({ u: view.updatedBy }));
    const act = (await api("/api/company")).activity;
    const entry = act.find((a) => a.kind === "profile_updated" && a.agentId === writer.id);
    assert(entry && entry.text.includes("Company Writer Agent") && entry.reason?.includes("owner confirmed"), JSON.stringify(entry));
    assert(!JSON.stringify(act).includes("America/Chicago"), "activity leaks changed values");
    // guard: the identical call again in the same scope is deduplicated
    const again = await run(writer.id, "company__update_company_profile", { reason: "The owner confirmed the new suite number and support site in chat.", description: "Agent24 Test Co runs autonomous AI operations teams for small businesses.", address: { line2: "Suite 410" }, timezone: "America/Chicago" }, wScope);
    assert(again.guard.outcome === "deduplicated" || /No change/.test(again.result ?? ""), JSON.stringify({ g: again.guard, r: again.result?.slice(0, 80) }));
    await api("/api/company", { timezone: "America/New_York", ownerTitle: PROFILE.ownerTitle, address: { ...PROFILE.address } }, "PATCH");
    return "fields merged, attributed, deduplicated";
  });

  await test("an agent write can neither clear a value nor delete anything", async () => {
    const wScope = `${scope}:w2`;
    const blank = await run(writer.id, "company__update_company_profile", { reason: "attempting to clear the legal name", legal_name: "", industry: "" }, wScope);
    assert(!blank.ok && /cannot clear it/i.test(blank.error), blank.error ?? blank.result);
    const view = (await api("/api/company")).profile;
    assert(view.legalName === PROFILE.legalName && view.industry === PROFILE.industry, `agent cleared a field: ${JSON.stringify({ l: view.legalName, i: view.industry })}`);
    for (const t of ["company__delete_company_contact", "company__remove_company_contact", "company__clear_company_profile"]) {
      const w = await run(writer.id, t, { contact_id: view.contacts[0].id, reason: "x" }, wScope);
      assert(!w.ok, `${t} exists — deletion must stay with the owner`);
    }
    const ok = await api(`/api/company/contacts/${view.contacts.find((c) => c.name === "Sales").id}`, null, "DELETE");
    assert(ok.ok, "owner cannot delete");
    const back = (await api("/api/company/contacts", { type: "EMAIL", name: "Sales", value: "sales@test.agent24.io", description: "Use for sales, customer acquisition and commercial communication with prospects." })).contact;
    created.contacts.push(back.id);
    return "empty values ignored, no delete tool, owner delete still works";
  });

  await test("authorized agent adds and updates contacts; marked as agent-saved; validation still applies", async () => {
    const wScope = `${scope}:w3`;
    const r = await run(writer.id, "company__add_company_contact", { type: "EMAIL", name: "Billing", value: "billing@test.agent24.io", description: "Use for invoices, receipts and billing correspondence with vendors.", reason: "Created the billing mailbox during the Vantage Cloud signup." }, wScope);
    assert(r.ok, r.error);
    const id = parse(r).contact_id;
    created.contacts.push(id);
    const view = (await api("/api/company")).profile;
    const saved = view.contacts.find((c) => c.id === id);
    assert(saved.createdBy === writer.id && saved.description.includes("invoices") && !saved.isPrimary, JSON.stringify(saved));
    const dup = await run(writer.id, "company__add_company_contact", { type: "EMAIL", name: "Billing again", value: "billing@test.agent24.io", description: "Duplicate of the billing mailbox address.", reason: "duplicate check" }, `${wScope}:dup`);
    assert(!dup.ok && /already saved/i.test(dup.error), dup.error ?? dup.result);
    const bad = await run(writer.id, "company__add_company_contact", { type: "EMAIL", name: "Bad", value: "nope", description: "Long enough description here.", reason: "validation check" }, `${wScope}:bad`);
    assert(!bad.ok && /valid email/i.test(bad.error), bad.error ?? bad.result);
    const upd = await run(writer.id, "company__update_company_contact", { contact_id: "billing@test.agent24.io", status: "INACTIVE", reason: "The billing mailbox was closed by the provider." }, wScope);
    assert(upd.ok && parse(upd).status === "INACTIVE", upd.error ?? upd.result);
    const p = parse(await run(A, "company__get_company_profile", {}, scope));
    assert(!p.contacts.some((c) => c.value === "billing@test.agent24.io"), "inactive contact still offered to agents");
    return "added, duplicate and invalid rejected, deactivated";
  });

  await test("an agent write resolves a waiting information request and resumes the requester", async () => {
    const r = await run(A, "company__request_company_info", { field: "legal.registered_address", needed_by: "Vantage Cloud business verification", reason: "Vantage asks for the registered legal address." }, `${scope}:r2`);
    assert(r.ok, r.error);
    const waiting = (await api("/api/company")).requests.find((x) => x.status === "WAITING" && x.field === "legal.registered_address");
    assert(waiting, "request not created");
    const w = await run(writer.id, "company__update_company_profile", { reason: "Read the registered address from the company's filed articles of organization.", legal: { registered_address: { line1: "1 Registry Way", city: "Boston", state: "Massachusetts", postal_code: "02110", country: "United States" } } }, `${scope}:w4`);
    assert(w.ok, w.error);
    assert(parse(w).resolved_requests?.includes("Registered legal address"), w.result.slice(0, 300));
    const after = (await api("/api/company")).requests.find((x) => x.id === waiting.id);
    assert(after.status === "RESOLVED", after.status);
    let msgs = [];
    for (let i = 0; i < 120; i++) { msgs = (await api(`/api/agents/${A}/messages`)).messages; if (msgs.some((m) => m.origin === "system" && /Registered legal address/.test(m.content))) break; await sleep(1000); }
    assert(msgs.some((m) => m.origin === "system" && /Registered legal address/.test(m.content)), "resume message not delivered");
    return "agent-provided value resolved the owner request";
  });

  await test("a DISMISSED information request reaches the agent instead of leaving it parked", async () => {
    // a value that is not a canonical profile field, so the fixture profile
    // filled in earlier in this run cannot already satisfy it
    const label = `Vendor account reference ${Date.now().toString(36).slice(-4)}`;
    const r = await run(A, "company__request_company_info", { field: label, needed_by: "a vendor form in this regression run", reason: "This request exists so that dismissing it can be checked." }, `${scope}:dismiss`);
    assert(r.ok, r.error);
    const waiting = (await api("/api/company")).requests.find((x) => x.status === "WAITING" && x.requesterAgentId === A && x.label === label);
    assert(waiting, "request not created");
    assert((await api(`/api/agents/${A}`)).agent.waiting?.kind === "company", "the agent did not park on it");
    const before = (await api(`/api/agents/${A}/messages`)).messages.length;
    await api(`/api/company/requests/${waiting.id}`, { action: "cancel" });
    let told = null;
    for (let i = 0; i < 40; i++) {
      told = (await api(`/api/agents/${A}/messages`)).messages.slice(before).find((m) => m.origin === "system" && m.content.includes(waiting.id.slice(0, 8)) && /DISMISSED/.test(m.content));
      if (told) break;
      await sleep(400);
    }
    assert(told, "the owner dismissed the request and the agent was never told");
    assert(/do not ask for it again|Do NOT invent/i.test(told.content), told.content.slice(0, 160));
    assert(!(await api(`/api/agents/${A}`)).agent.waiting, "still parked after the dismissal");
    return "told, and released";
  });

  await test("§22/§23 activity records what happened without values; Capability Manager has read access", async () => {
    const act = (await api("/api/company")).activity;
    assert(act.some((a) => a.kind === "profile_updated") && act.some((a) => a.kind === "contact_added") && act.some((a) => a.kind === "read" && /Company Test Agent/.test(a.text)), JSON.stringify(act.map((a) => a.kind)));
    const text = JSON.stringify(act);
    for (const v of [TAX_ID, "123456789", "MA-778-2231", "+1 617 555 0142"]) assert(!text.includes(v), `activity leaks ${v}`);
    const cm = (await api("/api/agents")).agents.find((a) => a.id === "capability-manager");
    assert(cm && cm.toolPermissions.includes("company_profile"), JSON.stringify(cm?.toolPermissions));
    const r = await run("capability-manager", "company__get_company_profile", {}, `${scope}:cm`);
    assert(r.ok && parse(r).name === PROFILE.name, r.error ?? r.result.slice(0, 200));
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    assert(!JSON.stringify(db.companyActivity).includes(TAX_ID), "EIN persisted into activity");
    return "activity clean; Capability Manager read OK";
  });

  await test("§24 CEO has read access to the company profile", async () => {
    const ceo = (await api("/api/agents")).agents.find((a) => a.dept === "ceo");
    assert(ceo, "no CEO agent");
    assert(ceo.toolPermissions.includes("company_profile"), `CEO ${ceo.name} lacks company_profile: ${JSON.stringify(ceo.toolPermissions)}`);
    const r = await run(ceo.id, "company__get_company_profile", {}, `${scope}:ceo`);
    assert(r.ok && parse(r).name === PROFILE.name, r.error ?? r.result.slice(0, 200));
    return `${ceo.name} (CEO) can read the profile`;
  });
} finally {
  if (!KEEP) {
    for (const id of created.contacts) await api(`/api/company/contacts/${id}`, null, "DELETE").catch(() => undefined);
    for (const r of (await api("/api/company").catch(() => ({ requests: [] }))).requests) if (r.status === "WAITING") await api(`/api/company/requests/${r.id}`, { action: "cancel" }).catch(() => undefined);
    await api("/api/company", { name: "", legalName: "", entityType: "", industry: "", website: "", description: "", timezone: "", ownerFirstName: "", ownerLastName: "", ownerTitle: "", address: {}, billingSameAsCompany: true, billingAddress: {}, legal: { entityType: "", registrationState: "", registrationCountry: "", formationDate: "", registrationNumber: "", taxId: "", registeredAddress: {} } }, "PATCH").catch(() => undefined);
    for (const a of [agent, plain, writer]) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
  } else console.log(`kept: agent ${A}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
