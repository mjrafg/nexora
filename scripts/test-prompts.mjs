#!/usr/bin/env node
/* ------------------------------------------------------------------
   The Prompt Registry.

   What has to hold for the owner to trust this page: the built-in text
   is never lost, an edit actually reaches the model, resetting really
   does put the original back, and an import can never quietly replace
   something they wrote themselves.

   Usage: node scripts/test-prompts.mjs [baseUrl] [--keep]
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
const raw = async (url, body) => {
  const r = await fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, text: await r.text(), headers: r.headers };
};
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 400)}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const MARK = "\n\nNEXORA PROMPT TEST MARKER — remove me.";
const touched = new Set();
const made = [];
const custom = async (id, content) => { touched.add(id); return api(`/api/prompts/${id}`, { content }); };
const reset = async (id) => api(`/api/prompts/${id}`, { reset: true });

try {
  await test("A - every prompt is registered with the metadata the page needs", async () => {
    const { prompts, counts, categories } = await api("/api/prompts");
    assert(prompts.length >= 40, `${prompts.length} prompts registered`);
    const ids = prompts.map((p) => p.id);
    assert(new Set(ids).size === ids.length, "two prompts share an id");
    for (const p of prompts) {
      assert(/^[a-z0-9][a-z0-9-]*$/.test(p.id), `id "${p.id}" is not a stable slug`);
      assert(p.name && p.description && p.category, `${p.id} is missing name/description/category`);
      assert(Number.isInteger(p.version) && p.version >= 1, `${p.id} has no version`);
      assert(p.defaultContent && p.defaultContent.trim(), `${p.id} has no built-in content`);
      assert(p.content === (p.customized ? p.customContent : p.defaultContent), `${p.id} resolves to something else`);
    }
    assert(counts.all === prompts.length, `${counts.all} counted vs ${prompts.length}`);
    assert(categories.reduce((n, c) => n + c.count, 0) === prompts.length, "the category counts do not add up");
    return `${prompts.length} prompts across ${new Set(prompts.map((p) => p.category)).size} categories`;
  });

  await test("B - the ones the product cannot run without are all there", async () => {
    const { prompts } = await api("/api/prompts");
    const need = [
      "agent-autonomy-rule", "task-execution-rule", "manager-management-rule", "delegation-rule", "ceo-coordination-rule",
      "credential-handling-rule", "payment-handling-rule", "company-profile-rule", "browser-behavior-rule",
      "capability-manager-playbook", "project-director-system", "project-builder-system", "project-reviewer-system",
      "task-brief", "agent-closing-line",
    ];
    const missing = need.filter((id) => !prompts.some((p) => p.id === id));
    assert(!missing.length, `not registered: ${missing.join(", ")}`);
    return `${need.length} named prompts present`;
  });

  await test("C - with no override the built-in is what is used", async () => {
    const { prompt } = await api("/api/prompts/task-execution-rule");
    assert(!prompt.customized && prompt.status === "built-in", JSON.stringify({ c: prompt.customized, s: prompt.status }));
    assert(prompt.content === prompt.defaultContent, "the resolved text is not the built-in");
    return `v${prompt.version}, unmodified`;
  });

  await test("D - an edit is what the runtime then uses, and the built-in is untouched", async () => {
    const before = (await api("/api/prompts/task-execution-rule")).prompt;
    const { prompt } = await custom("task-execution-rule", before.defaultContent + MARK);
    assert(prompt.customized && prompt.status === "customized", JSON.stringify(prompt.status));
    assert(prompt.content.endsWith(MARK), "the edit did not take");
    assert(prompt.defaultContent === before.defaultContent, "editing changed the built-in text");
    // and it really is what an agent is assembled with
    const conns = (await api("/api/providers")).connections;
    const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
    const a = (await api("/api/agents", { name: "Prompt Test Agent", role: "Engineer", dept: "engineering", toolPermissions: [], runtime })).agent;
    made.push(a.id);
    const assembled = (await api(`/api/agents/${a.id}/prompt`)).prompt;
    assert(assembled.includes(MARK), "the agent's system prompt does not contain the owner's text");
    return "edited, and the agent receives it";
  });

  await test("E - the change is recorded, and resetting puts the built-in back", async () => {
    const { revisions } = await api("/api/prompts/task-execution-rule");
    assert(revisions.length >= 1 && revisions[0].source === "MANUAL", JSON.stringify(revisions.slice(0, 1)));
    const { prompt } = await reset("task-execution-rule");
    assert(!prompt.customized, "still customized after a reset");
    assert(prompt.content === prompt.defaultContent, "reset did not restore the built-in");
    const after = await api("/api/prompts/task-execution-rule");
    assert(after.revisions.some((r) => r.source === "RESET" && r.content === null), "the reset was not recorded");
    const assembled = (await api(`/api/agents/${made[0]}/prompt`)).prompt;
    assert(!assembled.includes(MARK), "the agent still receives the removed text");
    return `${after.revisions.length} revisions kept`;
  });

  await test("F - an earlier version can be restored", async () => {
    await custom("task-execution-rule", (await api("/api/prompts/task-execution-rule")).prompt.defaultContent + MARK);
    await reset("task-execution-rule");
    const { revisions } = await api("/api/prompts/task-execution-rule");
    const edit = revisions.find((r) => r.content && r.content.endsWith(MARK));
    assert(edit, "the edit is not in the history");
    const { prompt } = await api(`/api/prompts/task-execution-rule`, { revisionId: edit.id });
    assert(prompt.customized && prompt.content.endsWith(MARK), "restoring an earlier version did nothing");
    await reset("task-execution-rule");
    return "restored, then reset again";
  });

  await test("G - a prompt the product needs cannot be left empty", async () => {
    for (const body of [{ content: "" }, { content: "   \n  " }]) {
      const r = await fetch(`${BASE}/api/prompts/task-execution-rule`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
      assert(!r.ok, `an empty prompt was accepted: ${JSON.stringify(body)}`);
    }
    const { prompt } = await api("/api/prompts/task-execution-rule");
    assert(!prompt.customized, "a refused save left an override behind");
    return "empty saves refused";
  });

  await test("H - a prompt that does not exist is not silently created", async () => {
    const r = await fetch(`${BASE}/api/prompts/not-a-real-prompt-id`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ content: "hello" }) });
    assert(r.status === 404, `status ${r.status}`);
    const { prompts } = await api("/api/prompts");
    assert(!prompts.some((p) => p.id === "not-a-real-prompt-id"), "an unknown id appeared in the registry");
    return "404, nothing created";
  });

  await test("I - shared rules are composed, not copied: one edit reaches every agent that carries it", async () => {
    const conns = (await api("/api/providers")).connections;
    const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
    const worker = (await api("/api/agents", { name: "Prompt Shared Worker", role: "Integrations Engineer", dept: "engineering", toolPermissions: ["credentials"], runtime })).agent;
    const boss = (await api("/api/agents", { name: "Prompt Shared Boss", role: "Engineering Manager", dept: "engineering", toolPermissions: ["credentials"], runtime })).agent;
    made.push(worker.id, boss.id);
    await api(`/api/agents/${worker.id}`, { managerAgentId: boss.id }, "PATCH");
    const before = (await api("/api/prompts/credential-handling-rule")).prompt;
    await custom("credential-handling-rule", before.defaultContent + MARK);
    for (const id of [worker.id, boss.id]) {
      const p = (await api(`/api/agents/${id}/prompt`)).prompt;
      assert(p.includes(MARK), "one of the two agents did not get the shared rule");
      assert(p.split(MARK).length === 2, "the shared rule was pasted in more than once");
    }
    await reset("credential-handling-rule");
    return "one definition, two agents, one copy each";
  });

  await test("J - the order the pieces are assembled in is preserved", async () => {
    const boss = made.find(Boolean) && (await api("/api/agents")).agents.find((a) => a.name === "Prompt Shared Boss");
    const p = (await api(`/api/agents/${boss.id}/prompt`)).prompt;
    const order = ["# Identity", "# Autonomy", "# Credentials", "# Working a task", "# Missing capabilities", "# Management responsibility", "# Work you have delegated", "You are talking privately with the company owner"];
    let at = -1;
    for (const marker of order) {
      const i = p.indexOf(marker);
      assert(i > -1, `"${marker}" is missing from the assembled prompt`);
      assert(i > at, `"${marker}" appears out of order`);
      at = i;
    }
    return order.length + " sections, in order";
  });

  await test("K - export carries stable ids and the text actually in use", async () => {
    const before = (await api("/api/prompts/manager-management-rule")).prompt;
    await custom("manager-management-rule", before.defaultContent + MARK);
    const r = await raw("/api/prompts/export", {});
    assert(r.ok, `export failed: ${r.status}`);
    assert(/attachment; filename="nexora-prompts-\d{4}-\d{2}-\d{2}\.json"/.test(r.headers.get("content-disposition") ?? ""), r.headers.get("content-disposition"));
    const file = JSON.parse(r.text);
    assert(file.format === "nexora-prompts" && file.version === 1 && Array.isArray(file.prompts), JSON.stringify({ f: file.format, v: file.version }));
    const mine = file.prompts.find((p) => p.id === "manager-management-rule");
    assert(mine && mine.customized === true && mine.content.endsWith(MARK), "the export does not carry the customization");
    assert(file.prompts.every((p) => p.id && p.name && p.category && Number.isInteger(p.built_in_version)), "an export entry is missing its metadata");
    const one = JSON.parse((await raw("/api/prompts/export", { ids: ["task-brief"] })).text);
    assert(one.prompts.length === 1 && one.prompts[0].id === "task-brief", JSON.stringify(one.prompts.map((p) => p.id)));
    const cat = JSON.parse((await raw("/api/prompts/export", { category: "payments" })).text);
    assert(cat.prompts.length >= 2 && cat.prompts.every((p) => p.category === "payments"), JSON.stringify(cat.prompts.map((p) => p.category)));
    return `${file.prompts.length} exported, one and one category too`;
  });

  await test("L - import previews before it writes, and never overwrites your version quietly", async () => {
    const file = JSON.parse((await raw("/api/prompts/export", {})).text);
    // the file says something different for a prompt the owner has NOT touched…
    const target = file.prompts.find((p) => p.id === "task-brief");
    target.content += MARK;
    // …and for one they have
    const conflict = file.prompts.find((p) => p.id === "manager-management-rule");
    conflict.content += " and again.";
    // …plus one this Nexora has never heard of
    file.prompts.push({ id: "totally-made-up-rule", name: "Made up", description: "", category: "other", built_in_version: 1, customized: true, content: "nope" });
    // …and one that is empty
    file.prompts.push({ id: "task-brief-no-detail", name: "Empty", description: "", category: "task", built_in_version: 1, customized: true, content: "   " });

    const { preview, suggested } = await api("/api/prompts/import", { file });
    assert(preview.ok, preview.error);
    assert(preview.counts.update >= 1, JSON.stringify(preview.counts));
    assert(preview.counts.conflict >= 1, "the owner's own customization was not flagged as a conflict");
    assert(preview.counts.unknown === 1, `${preview.counts.unknown} unknown`);
    assert(preview.counts.invalid === 1, `${preview.counts.invalid} invalid`);
    assert(preview.entries.find((e) => e.id === "totally-made-up-rule").verdict === "unknown", "an unknown id was not marked unknown");
    assert(!suggested.includes("totally-made-up-rule"), "an unknown id was suggested for import");
    // nothing has been written by previewing
    assert((await api("/api/prompts/task-brief")).prompt.customized === false, "the preview wrote something");

    // apply only the one that is safe to apply
    await api("/api/prompts/import", { file, apply: ["task-brief"] });
    assert((await api("/api/prompts/task-brief")).prompt.content.endsWith(MARK), "the selected prompt was not imported");
    touched.add("task-brief");
    assert((await api("/api/prompts/manager-management-rule")).prompt.content.endsWith(MARK), "the conflicting prompt was changed without being selected");
    const rev = (await api("/api/prompts/task-brief")).revisions[0];
    assert(rev.source === "IMPORT", `the import was recorded as ${rev.source}`);
    return `${preview.counts.total} entries previewed, 1 applied`;
  });

  await test("M - a bad file is refused with a reason", async () => {
    for (const [file, why] of [[{ format: "something-else", version: 1, prompts: [] }, "format"], [{ format: "nexora-prompts", version: 99, prompts: [] }, "version"], [{ format: "nexora-prompts", version: 1 }, "no prompts"]]) {
      const r = await fetch(`${BASE}/api/prompts/import`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ file }) });
      const j = await r.json();
      assert(!r.ok && j.preview?.error, `${why}: accepted a bad file`);
    }
    return "format, version and shape all checked";
  });

  await test("N - export → reset → import brings the customizations back exactly", async () => {
    const ids = ["task-execution-rule", "company-profile-rule", "payment-approved-resume"];
    const wanted = {};
    for (const id of ids) {
      const def = (await api(`/api/prompts/${id}`)).prompt.defaultContent;
      const text = `${def}${MARK} (${id})`;
      await custom(id, text);
      wanted[id] = text;
    }
    const file = JSON.parse((await raw("/api/prompts/export", { ids })).text);
    for (const id of ids) await reset(id);
    for (const id of ids) assert(!(await api(`/api/prompts/${id}`)).prompt.customized, `${id} was not reset`);
    await api("/api/prompts/import", { file, apply: ids });
    for (const id of ids) {
      const p = (await api(`/api/prompts/${id}`)).prompt;
      assert(p.customized, `${id} did not come back`);
      assert(p.content === wanted[id], `${id} came back different`);
    }
    return `${ids.length} customizations survived the round trip`;
  });

  await test("O - overrides live in Nexora's data, not in the source defaults", async () => {
    const db = store();
    assert(Array.isArray(db.promptOverrides) && db.promptOverrides.length, "no overrides on disk");
    assert(Array.isArray(db.promptRevisions) && db.promptRevisions.length, "no revisions on disk");
    const one = db.promptOverrides.find((o) => o.promptId === "task-execution-rule");
    assert(one && one.content.endsWith(`(task-execution-rule)`), "the override on disk is not the owner's text");
    assert(Number.isInteger(one.baseVersion) && one.updatedBy === "owner", JSON.stringify({ v: one.baseVersion, by: one.updatedBy }));
    // and the built-in is still exactly what the API reports as the default
    const p = (await api("/api/prompts/task-execution-rule")).prompt;
    assert(p.defaultContent !== p.content, "the default and the override are the same text");
    return `${db.promptOverrides.length} overrides, ${db.promptRevisions.length} revisions on disk`;
  });
} finally {
  if (!KEEP) {
    for (const id of touched) await api(`/api/prompts/${id}`, { reset: true }).catch(() => undefined);
    for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => undefined);
    const left = (await api("/api/prompts").catch(() => ({ prompts: [] }))).prompts.filter((p) => p.customized);
    if (left.length) console.log(`(still customized after cleanup: ${left.map((p) => p.id).join(", ")})`);
  }
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
