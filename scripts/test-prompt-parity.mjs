#!/usr/bin/env node
/* ------------------------------------------------------------------
   Migration parity.

   Moving a prompt into the registry must not change one character of
   what a model actually receives. So this captures the real text — the
   assembled system prompt of ten differently-shaped agents, and the
   system messages Nexora sends when work is assigned, delegated,
   finished, blocked, or resumed after a wait — writes it to a file, and
   later compares the same capture against that file.

     node scripts/test-prompt-parity.mjs <baseUrl> capture <file>
     node scripts/test-prompt-parity.mjs <baseUrl> verify  <file>
   ------------------------------------------------------------------ */
import fs from "node:fs";

/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}


const BASE = process.argv[2] || "http://localhost:3111";
const MODE = process.argv[3] || "verify";
const FILE = process.argv[4] || "prompt-parity.json";
const USER = process.env.NEXORA_USER || "mjrafg";
const PASS = requirePassword();
let cookie = "";

async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}
const run = (agentId, tool, args, scopeId) => api("/api/tools/run", { agentId, tool, args, scopeId });
const parse = (r) => { try { return JSON.parse(r.result); } catch { return {}; } };
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const msgs = async (agentId, chatId) => (await api(`/api/agents/${agentId}/messages${chatId ? `?chat=${chatId}` : ""}`)).messages;
const systemText = async (agentId, chatId, re, ms = 15_000) => {
  for (let i = 0; i < ms / 300; i++) {
    const m = (await msgs(agentId, chatId)).filter((x) => x.origin === "system" && re.test(x.content ?? "")).at(-1);
    if (m) return m.content;
    await sleep(300);
  }
  return null;
};

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const conns = (await api("/api/providers")).connections;
const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
const made = [];
const mk = async (name, role, dept, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept, toolPermissions: perms, instructions: "Do the work you are given, honestly.", skills: ["a skill", "another skill"], runtime });
  made.push(agent.id);
  return agent;
};

const snap = {};
const created = [];

try {
  /* ---------- assembled system prompts, one per interesting shape ---------- */
  const shapes = [
    ["plain", await mk("Parity Plain", "Analyst", "operations", [])],
    ["browser", await mk("Parity Browser", "Researcher", "operations", ["browser", "web_search"])],
    ["credentials", await mk("Parity Credentials", "Integrations Engineer", "engineering", ["credentials", "credentials_manage"])],
    ["payments", await mk("Parity Payments", "Buyer", "finance", ["payments", "payments_use", "payments_manage"])],
    ["company", await mk("Parity Company", "Ops Analyst", "operations", ["company_profile", "company_profile_manage", "company_custom_data_manage"])],
    ["everything", await mk("Parity Everything", "Generalist", "operations", ["browser", "web_search", "web_fetch", "read_files", "write_files", "run_commands", "credentials", "credentials_manage", "payments", "payments_use", "payments_manage", "company_profile", "company_profile_manage", "company_custom_data_manage"])],
    ["employee", await mk("Parity Employee", "Engineer", "engineering", [])],
    ["manager", await mk("Parity Manager", "Engineering Manager", "engineering", ["company_profile"])],
    ["executive", await mk("Parity Executive", "Chief Executive", "ceo", ["company_profile"])],
  ];
  const by = Object.fromEntries(shapes);
  await api(`/api/agents/${by.employee.id}`, { managerAgentId: by.manager.id }, "PATCH");
  await api(`/api/agents/${by.manager.id}`, { managerAgentId: by.executive.id }, "PATCH");
  const capMgr = (await api("/api/agents")).agents.find((a) => a.system === "capability-manager");
  for (const [label, a] of [...shapes, ["capability-manager", capMgr]]) {
    if (!a) continue;
    snap[`system:${label}`] = (await api(`/api/agents/${a.id}/prompt`)).prompt;
  }

  /* ---------- the messages Nexora sends agents ---------- */
  const worker = await mk("Parity Worker", "Engineer", "engineering", ["credentials", "payments", "payments_use", "company_profile"]);
  await api(`/api/agents/${worker.id}`, { managerAgentId: by.manager.id }, "PATCH");

  // a task brief, with and without a folder
  const t1 = (await api("/api/tasks", { title: "Parity brief task", description: "Do the parity thing and write down what you found.", assignedToAgentId: worker.id })).task;
  created.push(t1.id);
  await sleep(1500);
  const t1v = (await api(`/api/tasks/${t1.id}`)).task;
  snap["message:task-brief"] = await systemText(worker.id, t1v.chatId, /You have been assigned a company task/);

  // a delegated result coming back into the objective
  const obj = (await api("/api/tasks", { title: "Parity objective", description: "Delegated out of this.", assignedToAgentId: by.manager.id })).task;
  created.push(obj.id);
  await sleep(1500);
  const objv = (await api(`/api/tasks/${obj.id}`)).task;
  const childA = parse(await run(by.manager.id, "work__create_task", { title: "Parity piece one", description: "The first piece.", assigned_to: worker.id }, `task:${obj.id}`));
  const childB = parse(await run(by.manager.id, "work__create_task", { title: "Parity piece two", description: "The second piece.", assigned_to: by.employee.id }, `task:${obj.id}`));
  created.push(childA.task_id, childB.task_id);
  await sleep(2000);
  await run(worker.id, "work__complete_task", { task_id: childA.task_id, summary: "Finished the first piece and verified the output reads back correctly.", result: { checked: 3 } }, `task:${childA.task_id}`);
  snap["message:delegated-done"] = await systemText(by.manager.id, objv.chatId, /Work you delegated is finished/);
  await sleep(1500);
  await run(by.employee.id, "work__block_task", { task_id: childB.task_id, reason: "The second piece needs an account only a human outside Nexora can create." }, `task:${childB.task_id}`);
  snap["message:delegated-blocked"] = await systemText(by.manager.id, objv.chatId, /Work you delegated is blocked/);

  // an outcome reported to an accountable manager rather than into an objective
  const solo = parse(await run(by.manager.id, "work__create_task", { title: "Parity solo piece", description: "Reported to the manager directly.", assigned_to: worker.id }, `chat:parity:${Date.now()}`));
  created.push(solo.task_id);
  await sleep(2000);
  await run(worker.id, "work__complete_task", { task_id: solo.task_id, summary: "Finished the solo piece and checked it against the brief." }, `task:${solo.task_id}`);
  const mgrChats = (await api(`/api/agents/${by.manager.id}/chats`)).chats ?? [];
  for (const c of mgrChats) {
    const t = await systemText(by.manager.id, c.id, /A task you are accountable for is finished/, 2000);
    if (t) { snap["message:manager-done"] = t; break; }
  }

  // waits: credential, company information, payment
  const t2 = (await api("/api/tasks", { title: "Parity wait task", description: "Parks on a login.", assignedToAgentId: worker.id })).task;
  created.push(t2.id);
  await sleep(2000);
  const t2v = (await api(`/api/tasks/${t2.id}`)).task;
  await run(worker.id, "credentials__request_credential", { service: "Parity Portal", site: "parity.example", login_url: "https://parity.example/login", reason: "The parity capture needs a login that does not exist." }, `task:${t2.id}`);
  const credReq = (await api("/api/logins")).requests.find((x) => x.executionScopeId === `task:${t2.id}`);
  const cred = (await api("/api/logins", { name: `Parity Portal ${Date.now()}`, service: "Parity Portal", site: "parity.example", description: "Created by the prompt-parity capture to record the resume text.", username: "tester@example.com", password: `pw-${Math.random().toString(36).slice(2)}`, requestId: credReq.id })).credential;
  snap["message:credential-resolved"] = await systemText(worker.id, t2v.chatId, /credential request/i);
  await api(`/api/credentials/${cred.id}`, null, "DELETE").catch(() => api(`/api/logins/${cred.id}`, null, "DELETE").catch(() => undefined));

  await run(worker.id, "company__request_company_info", { field: `Parity value ${Date.now().toString(36)}`, needed_by: "the prompt-parity capture", reason: "Recording the dismissal text." }, `task:${t2.id}`);
  const infoReq = (await api("/api/company")).requests.filter((x) => x.status === "WAITING" && x.requesterAgentId === worker.id).at(-1);
  await api(`/api/company/requests/${infoReq.id}`, { action: "cancel" });
  snap["message:company-dismissed"] = await systemText(worker.id, t2v.chatId, /company information request/i);

  const settings = (await api("/api/payments/settings")).settings;
  await api("/api/payments/settings", { autoApproveLimit: 5 }).catch(() => undefined);
  const pay = parse(await run(worker.id, "payments__request_payment", { merchant: "Parity Vendor", amount: 21, reason: "Recording the payment decision texts." }, `task:${t2.id}`));
  await api(`/api/payments/requests/${pay.payment_request_id}/reject`, { note: "not this time" });
  snap["message:payment-rejected"] = await systemText(worker.id, t2v.chatId, /REJECTED/);
  const pay2 = parse(await run(worker.id, "payments__request_payment", { merchant: "Parity Vendor Two", amount: 22, reason: "Recording the cancellation text." }, `task:${t2.id}:b`));
  await api(`/api/payments/requests/${pay2.payment_request_id}/cancel`, { note: "called off" });
  snap["message:payment-cancelled"] = await systemText(worker.id, t2v.chatId, /CANCELLED/);
  await api("/api/payments/settings", { autoApproveLimit: settings.autoApproveLimit }).catch(() => undefined);

  /* ---------- compare or record ---------- */
  const missing = Object.entries(snap).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.log(`(could not capture: ${missing.join(", ")})`);

  if (MODE === "capture") {
    fs.writeFileSync(FILE, JSON.stringify(snap, null, 2));
    console.log(`captured ${Object.keys(snap).length} texts → ${FILE}`);
  } else {
    const before = JSON.parse(fs.readFileSync(FILE, "utf8"));
    let same = 0;
    const diffs = [];
    for (const key of Object.keys(before)) {
      const a = normalise(before[key], key);
      const b = normalise(snap[key], key);
      if (a === b) same++;
      else diffs.push({ key, a, b });
    }
    for (const d of diffs) {
      console.log(`\nDIFFERS ${d.key}`);
      const al = (d.a ?? "").split("\n"), bl = (d.b ?? "").split("\n");
      for (let i = 0; i < Math.max(al.length, bl.length); i++) {
        if (al[i] !== bl[i]) console.log(`  line ${i + 1}\n    before: ${JSON.stringify(al[i])}\n    after:  ${JSON.stringify(bl[i])}`);
      }
    }
    console.log(`\n${same}/${Object.keys(before).length} texts identical to the pre-migration capture`);
    process.exit(diffs.length ? 1 : 0);
  }
} finally {
  for (const id of created.filter(Boolean)) await api(`/api/tasks/${id}`, { cancel: { reason: "prompt parity cleanup" } }, "PATCH").catch(() => undefined);
  for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => undefined);
}

/** Ids, names and timestamps differ between runs; the instruction text must not. */
function normalise(text, key) {
  if (text == null) return null;
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/#[0-9a-f]{8}\b/g, "#<short>")
    .replace(/Parity (Portal|Vendor Two|Vendor|value) ?[a-z0-9]*/g, "<name>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, "<time>")
    .replace(/Name: Parity [A-Za-z ]+/g, "Name: <agent>")
    .replace(/Stay in character as Parity [A-Za-z ]+/g, "Stay in character as <agent>")
    .replace(/Your direct reports: .*/g, "Your direct reports: <reports>")
    .replace(/\((id [^)]+)\)/g, "(<id>)")
    + (key.startsWith("system:") ? "" : "");
}
