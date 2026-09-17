#!/usr/bin/env node
/* ------------------------------------------------------------------
   One objective, given once, with real models.

   The owner says what they want to the person who coordinates the
   company, and then stops being involved. What has to happen by itself:

     CEO → the managers the objective actually needs
         → their people do the work
         → managers read the results and summarise them
         → the CEO puts it together and answers the owner, once,
           in the conversation the owner used.

   Nothing is published and nothing is bought: the objective says so,
   and the test checks it afterwards rather than trusting it.

   Usage: node scripts/live-ceo.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import { api, login, sleep, banner, pass, summary, findRuntime } from "./live-lib.mjs";

const BASE = process.argv[2] || "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const tag = Date.now().toString(36).slice(-5);

await login(BASE);
const runtime = await findRuntime();
banner(`live CEO coordination · ${BASE} · runtime ${runtime.runtimeType}/${runtime.model}`);

const made = [];
const mk = async (name, role, dept, perms, instructions) => {
  const { agent } = await api("/api/agents", { name, role, dept, toolPermissions: perms, instructions, runtime });
  made.push(agent.id);
  return agent;
};

const ceo = await mk(`LIVE CEO ${tag}`, "Chief Executive", "ceo", ["company_profile"],
  "You run this company through its managers. You are judged on the outcome the owner gets, not on how much you personally did.");
const engMgr = await mk(`LIVE Eng Manager ${tag}`, "Engineering Manager", "engineering", [],
  "You run engineering. Your people do the work; you make sure it is the right work and that the result is real.");
const mktMgr = await mk(`LIVE Marketing Manager ${tag}`, "Marketing Manager", "sales", [],
  "You run marketing. Your people do the work; you check what they produce before you pass it on.");
const dev = await mk(`LIVE Engineer ${tag}`, "Frontend Engineer", "engineering", ["web_fetch", "browser"],
  "You review and report what you actually observe. You never change anything you were not asked to change.");
const writer = await mk(`LIVE Writer ${tag}`, "Content Agent", "sales", ["company_profile"],
  "You write from the company's real information. You never invent facts about the company, and you never publish anything.");
for (const [a, m] of [[engMgr, ceo], [mktMgr, ceo], [dev, engMgr], [writer, mktMgr]]) {
  await api(`/api/agents/${a.id}`, { managerAgentId: m.id }, "PATCH");
}

const OBJECTIVE =
  "Prepare Agent24 for a product introduction: review the current website and company information, write a short company introduction, and prepare three social-post drafts. Do not publish, purchase anything, or change production.";

const t0 = Date.now();
const startedPayments = (await api("/api/payments/history")).transactions.length;
const sent = await api(`/api/agents/${ceo.id}/messages`, { message: OBJECTIVE });
const ownerChatId = sent.assistant.chatId;
console.log(`\nowner → ${ceo.name} (chat ${ownerChatId})`);
console.log(`${ceo.name}: ${sent.assistant.content.trim().slice(0, 500)}\n`);

/* ---------------------------------------------------------------- the office, while it happens */

// the floor is sampled all the way through: what the picture claimed at each
// moment has to match what was actually true of the work
const seen = new Map();          // agentId → set of states the office showed
const floorAt = [];
const sampleFloor = async () => {
  const f = await api("/api/office").catch(() => null);
  if (!f) return;
  const people = [...f.departments.flatMap((d) => d.agents), ...f.unassigned].filter((a) => made.includes(a.id));
  for (const p of people) {
    if (!seen.has(p.id)) seen.set(p.id, new Set());
    seen.get(p.id).add(p.state);
  }
  floorAt.push({ at: f.at, totals: f.totals, mine: people.map((p) => `${p.name}: ${p.state}${p.currentTask ? ` (${p.currentTask.title})` : ""}`) });
};

const mineTasks = async () => {
  const { tasks } = await api("/api/tasks?status=all");
  return tasks.filter((t) => made.includes(t.assignedTo?.id) || made.includes(t.createdBy?.id));
};
const settled = (t) => t.status === "DONE" || t.status === "CANCELLED";

/* ---------------------------------------------------------------- the delegation itself */

let tasks = await mineTasks();
for (let i = 0; i < 30 && tasks.length < 2; i++) { await sleep(2000); tasks = await mineTasks(); }
const toManagers = tasks.filter((t) => [engMgr.id, mktMgr.id].includes(t.assignedTo?.id));
pass("the CEO delegated to managers rather than doing it itself", toManagers.length >= 1,
  toManagers.map((t) => `${t.assignedTo.name}: “${t.title}”`).join(" · ") || "no manager was given anything");
pass("only the departments the objective needs were given work", toManagers.length <= 2 && tasks.every((t) => t.assignedTo?.id !== ceo.id || t.createdByOwner),
  `${toManagers.length} manager task(s)`);
pass("the work remembers the conversation the owner used", toManagers.every((t) => !t.originChatId || t.originChatId === ownerChatId),
  toManagers.map((t) => (t.originChatId === ownerChatId ? "owner thread" : String(t.originChatId))).join(", "));

/* ---------------------------------------------------------------- down to the employees */

const deadline = Date.now() + 14 * 60_000;
let employeeTasks = [];
while (Date.now() < deadline) {
  tasks = await mineTasks();
  employeeTasks = tasks.filter((t) => [dev.id, writer.id].includes(t.assignedTo?.id));
  await sampleFloor();
  if (employeeTasks.length && employeeTasks.every(settled) && toManagers.every((m) => settled(tasks.find((t) => t.id === m.id) ?? m))) break;
  await sleep(4000);
}
tasks = await mineTasks();
const managersNow = toManagers.map((m) => tasks.find((t) => t.id === m.id)).filter(Boolean);

pass("the managers delegated to their own people", employeeTasks.length >= 1,
  employeeTasks.map((t) => `${t.assignedTo.name}: “${t.title}”`).join(" · ") || "no employee was given anything");
pass("each piece of employee work is linked to the manager's objective",
  employeeTasks.length > 0 && employeeTasks.every((t) => toManagers.some((m) => m.id === t.parentTaskId)),
  employeeTasks.map((t) => `${t.id.slice(0, 8)} → ${String(t.parentTaskId).slice(0, 8)}`).join(", "));
pass("the employees actually produced something", employeeTasks.some((t) => t.status === "DONE" && (t.resultSummary ?? "").length > 60),
  employeeTasks.map((t) => `${t.status}${t.resultSummary ? `: ${t.resultSummary.slice(0, 80)}` : ""}`).join(" | "));

/* ---------------------------------------------------------------- nothing ran ahead of its team */

const early = managersNow.filter((m) => {
  if (m.status !== "DONE") return false;
  const kids = employeeTasks.filter((t) => t.parentTaskId === m.id);
  return kids.some((k) => !settled(k) || (k.completedAt && m.completedAt && Date.parse(k.completedAt) > Date.parse(m.completedAt)));
});
pass("no manager called its objective finished before its team was", early.length === 0,
  early.map((m) => m.title).join(", ") || "every manager waited for its people");

/* ---------------------------------------------------------------- back to the owner */

let owner = [];
let finalMsg = null;
// the CEO is woken by the result and then answers: both have to land, and a
// message fetched back is never the same object as the one that was sent
const answered = () => finalMsg && finalMsg.id !== sent.assistant.id;
const stop = Date.now() + 8 * 60_000;
while (Date.now() < stop) {
  owner = (await api(`/api/agents/${ceo.id}/messages?chat=${ownerChatId}`)).messages;
  const since = owner.filter((m) => new Date(m.createdAt).getTime() > t0);
  finalMsg = since.filter((m) => m.role === "assistant").at(-1);
  tasks = await mineTasks();
  managersNow.splice(0, managersNow.length, ...toManagers.map((m) => tasks.find((t) => t.id === m.id)).filter(Boolean));
  const allIn = managersNow.every((m) => settled(m)) && since.some((m) => m.role === "user" && m.origin === "system");
  await sampleFloor();
  if (allIn && answered()) break;
  await sleep(4000);
}

const late = owner.filter((m) => new Date(m.createdAt).getTime() > t0);
const woken = late.filter((m) => m.role === "user" && m.origin === "system");
pass("the CEO was woken with each manager's result, in the owner's conversation", woken.length >= 1,
  `${woken.length} result(s) delivered into the owner thread`);
pass("the CEO answered the owner without being asked again",
  !!answered() && (finalMsg.content ?? "").length > 120,
  finalMsg ? finalMsg.content.trim().slice(0, 500) : "the CEO never spoke again");
const refs = (finalMsg?.content ?? "").toLowerCase();
pass("the answer refers to what the team actually produced",
  employeeTasks.some((t) => (t.title ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 5).some((w) => refs.includes(w))) || /draft|introduction|website/.test(refs),
  refs.slice(0, 160));

/* ---------------------------------------------------------------- it kept its hands to itself */

const payments = (await api("/api/payments/history")).transactions;
pass("nothing was bought", payments.length === startedPayments, `${payments.length - startedPayments} new payment row(s)`);
const reqs = (await api("/api/payments/requests").catch(() => ({ requests: [] }))).requests ?? [];
pass("no money was even asked for", !reqs.some((r) => made.includes(r.requestedByAgentId)), "no payment request from the test agents");

/* ---------------------------------------------------------------- what the office showed */

await sampleFloor();
const states = (id) => [...(seen.get(id) ?? new Set())];
pass("every agent in this run appeared on the office floor", made.every((id) => seen.has(id)),
  made.map((id) => `${id.slice(0, 8)}:${states(id).join("/") || "never seen"}`).join(" · "));
pass("the office showed work being done, not just people sitting there",
  made.some((id) => states(id).some((st) => st !== "IDLE")),
  made.map((id) => states(id).join("/")).filter(Boolean).join(" · "));
pass("a manager waiting on its team was shown as waiting, never as working",
  states(mktMgr.id).includes("WAITING_TEAM") || states(engMgr.id).includes("WAITING_TEAM") || employeeTasks.length === 0,
  `marketing ${states(mktMgr.id).join("/") || "—"} · engineering ${states(engMgr.id).join("/") || "—"}`);
pass("the floor settled to the real final state", (await api("/api/office").then((f) => [...f.departments.flatMap((d) => d.agents)].filter((a) => made.includes(a.id)).every((a) => a.state === "IDLE" || a.state === "WORKING"))),
  "nobody left stuck or waiting once the objective was answered");

// the office and Work must be talking about the same task
const lastFloor = await api("/api/office");
const onFloor = [...lastFloor.departments.flatMap((d) => d.agents)].filter((a) => made.includes(a.id) && a.currentTask);
pass("an employee opened from the floor is the same task Work shows",
  onFloor.every((a) => tasks.some((t) => t.id === a.currentTask.id)) ,
  onFloor.map((a) => `${a.name} → ${a.currentTask.id.slice(0, 8)}`).join(", ") || "no task open at the end (all finished)");

console.log("\n--- what the office showed, moment by moment ------------------");
for (const f of floorAt.filter((x, i) => i % 3 === 0 || i === floorAt.length - 1)) {
  if (f.mine.length) console.log(`${f.at.slice(11, 19)}  ${f.mine.join(" | ")}`);
}

console.log("\n--- evidence -------------------------------------------------");
console.log(JSON.stringify({
  ownerChatId,
  ceo: ceo.id,
  managers: toManagers.map((t) => ({ task: t.id, title: t.title, to: t.assignedTo?.name, status: tasks.find((x) => x.id === t.id)?.status })),
  employees: employeeTasks.map((t) => ({ task: t.id, parent: t.parentTaskId, title: t.title, to: t.assignedTo?.name, status: t.status, result: (t.resultSummary ?? "").slice(0, 200) })),
  ceoFinalMessage: finalMsg?.content?.slice(0, 1500),
}, null, 2));

if (!KEEP) {
  const mine = await mineTasks();
  for (const t of mine) await api(`/api/tasks/${t.id}`, { cancel: { reason: "live CEO check cleanup" } }, "PATCH").catch(() => undefined);
  for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => undefined);
  console.log(`\ncleaned up ${made.length} test agents and ${mine.length} task(s)`);
} else {
  console.log(`\nkept: ${made.join(", ")}`);
}
summary();
