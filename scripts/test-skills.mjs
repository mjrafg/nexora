#!/usr/bin/env node
/* ------------------------------------------------------------------
   Selective skills.

   The promise is narrow and worth checking precisely: an agent that was
   given no skill is exactly the agent it was before this feature
   existed; an agent that asks what exists gets a list, not a library;
   reading a document teaches it something and permits it nothing; and
   what was actually delivered is recorded, per scope, with the revision
   it came from.

   The live half — the Director choosing skills for real work, a Builder
   and a Reviewer receiving different ones — is scripts/live-skills.mjs.

   Usage: node scripts/test-skills.mjs [baseUrl] [--keep]
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
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 400)}`); }
}
const run = (agentId, tool, args, scopeId) => api("/api/tools/run", { agentId, tool, args, scopeId });
const parse = (r) => { try { return JSON.parse(r.result); } catch { return null; } };

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const conns = (await api("/api/providers")).connections;
const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
const made = [];
const mk = async (name, role, dept, perms, skills) => {
  const { agent } = await api("/api/agents", { name, role, dept, toolPermissions: perms, instructions: "Do the work you are given, honestly.", skills, runtime });
  made.push(agent.id);
  return agent;
};
// remember the owner's switch as we found it, so the test puts it back
const originalSwitch = new Map();
const setEnabled = async (id, enabled) => {
  if (!originalSwitch.has(id)) originalSwitch.set(id, (await api("/api/skills")).skills.find((s) => s.id === id)?.enabled);
  return api(`/api/skills/${id}`, { enabled });
};

const tag = Date.now().toString(36).slice(-5);
const scopeA = `skills-test-a:${tag}`;
const scopeB = `skills-test-b:${tag}`;

try {
  const worker = await mk(`Skills Worker ${tag}`, "Engineer", "engineering", [], ["frontend", "debugging"]);
  const library = await api("/api/skills");

  /* ---------------------------------------------------------------- A */
  await test("A - an agent nobody gave a skill to is assembled exactly as before", async () => {
    const { prompt } = await api(`/api/agents/${worker.id}/prompt`);
    const leaks = ["list_skills", "read_skill", "# Skill:", "The following", "selected for this work", "library_revision"]
      .filter((s) => prompt.includes(s));
    assert(!leaks.length, `the assembled prompt mentions ${leaks.join(", ")}`);
    for (const s of library.skills) {
      assert(!prompt.includes(s.name), `the assembled prompt contains the skill name "${s.name}"`);
      assert(!prompt.includes(s.use), `the assembled prompt contains skill guidance`);
    }
    // the agent's own expertise tags are still plain metadata, not documents
    assert(prompt.includes("frontend"), "the agent's own skill tags disappeared from its prompt");
    return `${prompt.length} chars, no skill text, tags intact`;
  });

  await test("A - the three things Nexora says about skills are registered prompts, editable like the rest", async () => {
    const { prompts } = await api("/api/prompts");
    const mine = ["skills-director-note", "skills-selected-block", "skills-repair-reminder"].map((id) => prompts.find((p) => p.id === id));
    assert(mine.every(Boolean), "a skills prompt is missing from Settings → Prompts");
    for (const p of mine) assert(p.defaultContent?.trim() && p.description?.trim(), `${p.id} has no shipped text or description`);
    // the two role lines that were hardcoded literals are registered now too
    for (const id of ["project-reviewer-role-line", "project-artifact-reviewer-system"]) {
      assert(prompts.find((p) => p.id === id), `${id} is not registered`);
    }
    return "5 prompts registered";
  });

  /* ---------------------------------------------------------------- B */
  await test("B - the catalog is descriptions, not documents", async () => {
    const r = await run(worker.id, "skills__list_skills", {}, scopeA);
    assert(r.ok, r.error);
    const cat = parse(r);
    assert(cat?.skills?.length, "the catalog came back empty");
    assert(r.result.length < 4_000, `the catalog is ${r.result.length} chars — that is a library, not a list`);
    for (const s of cat.skills) {
      assert(s.skill_id && s.name && s.what_it_is_for && s.use_it_when, `${s.skill_id} is missing metadata the model needs to choose`);
      assert(s.source && s.approx_tokens_to_read > 0, `${s.skill_id} does not say where it came from or what it costs`);
    }
    // nothing from inside a body came along
    const full = await api(`/api/skills/${cat.skills[0].skill_id}`);
    const middle = full.delivered.slice(Math.floor(full.delivered.length / 2), Math.floor(full.delivered.length / 2) + 120);
    assert(!r.result.includes(middle), "the listing contains body text");
    const bodies = library.skills.filter((s) => s.enabled).reduce((n, s) => n + s.approxTokens, 0);
    return `${cat.skills.length} skills in ~${Math.round(r.result.length / 4)} tokens; delivering all of them would be ~${bodies}`;
  });

  await test("B - narrowing by phase works, and a phase that does not exist says so", async () => {
    const review = parse(await run(worker.id, "skills__list_skills", { phase: "review" }, scopeA));
    assert(review.skills.every((s) => s.phases.includes("review")), "a skill came back that is not for reviewing");
    assert(review.skills.length < library.skills.filter((s) => s.enabled).length, "narrowing returned everything");
    const bad = await run(worker.id, "skills__list_skills", { phase: "deployment" }, scopeA);
    assert(!bad.ok && /unknown phase/i.test(bad.error), `a made-up phase was accepted: ${bad.result || bad.error}`);
    return `review → ${review.skills.map((s) => s.skill_id).join(", ")}`;
  });

  /* ---------------------------------------------------------------- reading */
  await test("B - reading one skill returns that skill, not the repository", async () => {
    const r = await run(worker.id, "skills__read_skill", { skill_id: "debugging-and-error-recovery" }, scopeA);
    assert(r.ok, r.error);
    assert(r.result.includes("# Skill:"), "the reply is not a skill document");
    assert(r.result.includes("addyosmani/agent-skills"), "the reply does not say where the text came from");
    const others = library.skills.filter((s) => s.id !== "debugging-and-error-recovery");
    for (const o of others) assert(!r.result.includes(o.use), `reading one skill returned ${o.id} as well`);
    return `${r.result.length} chars`;
  });

  await test("B - a skill id that does not exist is an honest error, not a guess", async () => {
    const r = await run(worker.id, "skills__read_skill", { skill_id: "frontend-ui" }, scopeA);
    assert(!r.ok, "a wrong id was answered anyway");
    assert(/no skill with id/i.test(r.error) && /list_skills/.test(r.error), `unhelpful error: ${r.error}`);
    return r.error.slice(0, 80);
  });

  /* ---------------------------------------------------------------- G */
  await test("G - a supporting document a skill cites can be read", async () => {
    const withRefs = library.skills.find((s) => s.references.length);
    assert(withRefs, "no skill in the library cites a supporting document");
    const r = await run(worker.id, "skills__read_skill_reference", { reference_id: withRefs.references[0] }, scopeA);
    assert(r.ok, r.error);
    assert(r.result.includes("# Reference:") && r.result.length > 500, "the reference came back empty");
    return `${withRefs.references[0]} · ${r.result.length} chars`;
  });

  await test("G - a reference that is not there fails honestly instead of returning something else", async () => {
    const r = await run(worker.id, "skills__read_skill_reference", { reference_id: "deployment-checklist" }, scopeA);
    assert(!r.ok, "a missing reference returned content");
    assert(/no reference document/i.test(r.error), `unclear error: ${r.error}`);
    return r.error.slice(0, 70);
  });

  /* ---------------------------------------------------------------- H */
  await test("H - reading a skill grants nothing: the same agent is refused the same tool afterwards", async () => {
    const before = (await api(`/api/agents/${worker.id}`)).agent.toolPermissions.slice().sort();
    await run(worker.id, "skills__read_skill", { skill_id: "frontend-ui-engineering" }, scopeA);
    const denied = await run(worker.id, "browser__open_page", { url: "https://example.com" }, scopeA);
    assert(!denied.ok, "an agent with no browser opened a page after reading a skill");
    const after = (await api(`/api/agents/${worker.id}`)).agent.toolPermissions.slice().sort();
    assert(JSON.stringify(before) === JSON.stringify(after), `permissions changed: ${before} → ${after}`);
    const prompt = (await api(`/api/agents/${worker.id}/prompt`)).prompt;
    assert(!prompt.includes("# Skill:"), "reading a skill wrote itself into the agent's standing prompt");
    return `permissions unchanged (${after.length}), browser still refused`;
  });

  /* ---------------------------------------------------------------- E + J */
  await test("E - what one scope read does not appear in another scope's record", async () => {
    await run(worker.id, "skills__read_skill", { skill_id: "code-review-and-quality" }, scopeB);
    const rows = store().skillDeliveries ?? [];
    const a = rows.filter((r) => r.scopeId === scopeA).map((r) => r.skillId);
    const b = rows.filter((r) => r.scopeId === scopeB).map((r) => r.skillId);
    assert(b.includes("code-review-and-quality"), "the read was not recorded");
    assert(!a.includes("code-review-and-quality"), "a read in one scope was recorded against another");
    assert(!b.includes("debugging-and-error-recovery"), "scopes are sharing deliveries");
    return `${scopeA}: ${[...new Set(a)].join(", ")} · ${scopeB}: ${[...new Set(b)].join(", ")}`;
  });

  await test("J - the owner can see what was delivered, how, and from which revision", async () => {
    const { deliveries, source } = await api("/api/skills");
    const mine = deliveries.filter((d) => d.scopeId === scopeA || d.scopeId === scopeB);
    assert(mine.length >= 4, `only ${mine.length} deliveries recorded`);
    for (const d of mine) {
      assert(d.revision === source.revision, `${d.skillId} was recorded against revision ${d.revision}`);
      assert(d.via === "tool" || d.via === "brief", `unknown delivery route ${d.via}`);
      assert(d.agentId === worker.id && d.bytes > 0, "the record does not say who received it or how much");
    }
    return `${mine.length} deliveries at ${source.revision.slice(0, 7)}`;
  });

  /* ---------------------------------------------------------------- the owner's switch */
  await test("the owner can turn a skill off, and then it cannot be read at all", async () => {
    await setEnabled("code-review-and-quality", false);
    const r = await run(worker.id, "skills__read_skill", { skill_id: "code-review-and-quality" }, scopeA);
    assert(!r.ok, "a skill the owner turned off was still handed over");
    assert(/settings/i.test(r.error), `the refusal does not say who controls it: ${r.error}`);
    const cat = parse(await run(worker.id, "skills__list_skills", {}, scopeA));
    assert(!cat.skills.find((s) => s.skill_id === "code-review-and-quality"), "a disabled skill is still offered in the catalog");
    await setEnabled("code-review-and-quality", true);
    const back = await run(worker.id, "skills__read_skill", { skill_id: "code-review-and-quality" }, scopeA);
    assert(back.ok, "turning it back on did not restore it");
    return "off → refused and unlisted; on → readable again";
  });

  await test("a skill that ships disabled says why, and stays off until the owner decides", async () => {
    const off = library.skills.filter((s) => !s.enabled);
    assert(off.length >= 1, "nothing ships off — the testing skill was meant to");
    for (const s of off) assert(s.disabledReason?.length > 40, `${s.id} is off with no explanation`);
    const tdd = off.find((s) => s.id === "test-driven-development");
    assert(tdd, "test-driven-development is not the skill held back");
    assert(/responsib/i.test(tdd.disabledReason), `the reason does not name the real issue: ${tdd.disabledReason}`);
    return tdd.disabledReason.slice(0, 90) + "…";
  });

  /* ---------------------------------------------------------------- source integrity */
  await test("the imported text is the published text, and Nexora's own notes are kept separate", async () => {
    const { source } = await api("/api/skills");
    assert(/^[0-9a-f]{40}$/.test(source.revision), `the library is not pinned to a commit: ${source.revision}`);
    assert(source.license === "MIT" && source.repo === "addyosmani/agent-skills", "attribution is missing");
    for (const s of library.skills) {
      const full = await api(`/api/skills/${s.id}`);
      const body = full.delivered.split("## The document, as published\n\n")[1];
      assert(body && body.length > 1_000, `${s.id} has no document under the heading`);
      if (s.adaptation) {
        const note = full.delivered.split("## How this applies in Nexora (Nexora's note, not the source's)\n")[1]?.split("\n\n")[0];
        assert(note?.includes(s.adaptation.split("\n")[0]), `${s.id}'s Nexora note is not where the agent will read it`);
        assert(!body.includes(s.adaptation.split("\n")[0]), `${s.id}'s Nexora note was merged into the upstream text`);
      }
    }
    return `${library.skills.length} documents at ${source.revision.slice(0, 7)}, ${source.license}`;
  });

  /* ---------------------------------------------------------------- I */
  await test("I - the review contract the parser depends on is untouched", async () => {
    const { prompts } = await api("/api/prompts");
    for (const id of ["project-reviewer-output-format", "project-reviewer-system", "project-reviewer-role-line"]) {
      const p = prompts.find((x) => x.id === id);
      assert(p && !p.customized, `${id} is customized — this test cannot tell what shipped`);
      assert(p.content === p.defaultContent, `${id} no longer resolves to its shipped text`);
    }
    const fmt = prompts.find((x) => x.id === "project-reviewer-output-format").content;
    assert(/PASS/.test(fmt) && /FINDINGS/.test(fmt), "the verdict format no longer names PASS/FINDINGS");
    // and the skill that could plausibly argue with it says Nexora wins, by name
    const review = library.skills.find((s) => s.id === "code-review-and-quality");
    assert(/PASS or FINDINGS/.test(review.adaptation), "the review skill does not restate Nexora's verdict contract");
    assert(/two rounds/.test(review.adaptation), "the review skill does not restate Nexora's review limit");
    return "verdict format and review limit restated in the adapted skill";
  });

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
} finally {
  if (!KEEP) {
    for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => {});
    // the owner's switches go back to exactly how this test found them
    for (const [id, enabled] of originalSwitch) {
      if (typeof enabled === "boolean") await api(`/api/skills/${id}`, { enabled }).catch(() => {});
    }
    console.log(`cleaned up ${made.length} test agent(s)`);
  }
}
process.exit(results.every(Boolean) ? 0 : 1);
