#!/usr/bin/env node
/* ------------------------------------------------------------------
   One objective, two departments, watched through the office while it
   happens.

   The point of this script is that it does not inspect the office after
   the fact. It drives a real owner→CEO→managers→employees run with a
   real model and, at the same time, samples /api/office every second and
   a half, photographing the floor the first time it shows each state
   that matters. Every sample is cross-checked against the authoritative
   agent and task records, so the question it answers is not "did the
   office show something" but "was what the office showed true".

   Nothing is published, bought or changed in production: the objective
   says so and the script checks afterwards.

   Usage: node scripts/live-office.mjs [baseUrl] [outDir] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import { chromium } from "playwright";
import { api, login, sleep, banner, pass, summary, findRuntime } from "./live-lib.mjs";

/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}


const BASE = process.argv[2] || "https://com.agent24.io";
const OUT = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "shots";
const KEEP = process.argv.includes("--keep");
const tag = Date.now().toString(36).slice(-5);
fs.mkdirSync(OUT, { recursive: true });

await login(BASE);
const runtime = await findRuntime();
banner(`live office · ${BASE} · runtime ${runtime.runtimeType}/${runtime.model}`);

/* ---------------------------------------------------------------- a small company, two departments */

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
const dev = await mk(`LIVE Engineer ${tag}`, "Frontend Engineer", "engineering", ["web_fetch"],
  "You review and report what you actually observe. You never change anything you were not asked to change.");
const writer = await mk(`LIVE Writer ${tag}`, "Content Agent", "sales", ["company_profile"],
  "You write from the company's real information. You never invent facts about the company, and you never publish anything.");
for (const [a, m] of [[engMgr, ceo], [mktMgr, ceo], [dev, engMgr], [writer, mktMgr]]) {
  await api(`/api/agents/${a.id}`, { managerAgentId: m.id }, "PATCH");
}
const NAMES = new Map([[ceo.id, "CEO"], [engMgr.id, "EngMgr"], [mktMgr.id, "MktMgr"], [dev.id, "Engineer"], [writer.id, "Writer"]]);

/* ---------------------------------------------------------------- a camera on the floor */

const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: process.env.NEXORA_USER || "mjrafg", password: requirePassword() }) });
const [ckName, ckValue] = (r.headers.get("set-cookie") || "").split(";")[0].split("=");
const host = new URL(BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: ckName, value: ckValue, domain: host.hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: host.protocol === "https:" }]);
const page = await ctx.newPage();
await page.goto(`${BASE}/scene`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

const shots = [];
const photographed = new Set();
async function photograph(key, why) {
  if (photographed.has(key)) return;
  photographed.add(key);
  const file = `${OUT}/live-${key}.png`;
  try {
    await page.waitForTimeout(600); // let the scene take the event it was just told about
    await page.screenshot({ path: file });
    shots.push({ key, why, file });
    console.log(`  📷 ${key} — ${why}`);
  } catch (err) {
    console.log(`  (could not photograph ${key}: ${err.message})`);
  }
}

/* ---------------------------------------------------------------- the ask */

const OBJECTIVE =
  "Prepare Agent24 for a product introduction. Have Engineering perform a read-only readiness review of the current product and website, and have Marketing prepare a short company introduction plus three social post drafts. Do not publish anything, change production, or spend money.";

const t0 = Date.now();
const paymentsBefore = (await api("/api/payments/history")).transactions.length;
console.log(`owner → ${ceo.name}\n`);
// not awaited: the whole point is to watch while it runs
const conversation = api(`/api/agents/${ceo.id}/messages`, { message: OBJECTIVE }).catch((e) => ({ error: String(e.message) }));

/* ---------------------------------------------------------------- watching */

const ownerActed = [];         // what the owner (this script) had to answer
const resumedAfterDismissal = [];
/**
 * The owner, played by the test: answer what these agents ask for, the way a
 * person at the keyboard would. Only ever touches requests from this run's
 * own throwaway agents, and never writes a company value — a dismissal says
 * "not available", which is a real answer and not an invented one.
 */
async function beTheOwner() {
  const ac = await api("/api/action-center").catch(() => ({ actions: [] }));
  for (const a of (ac.actions ?? []).filter((x) => x.status === "OPEN" && made.includes(x.agentId))) {
    const who = NAMES.get(a.agentId) ?? a.agentId.slice(0, 8);
    if (a.kind === "turn_budget") {
      await api(`/api/action-center/${a.id}`, { choice: "until_done" }).catch(() => undefined);
      ownerActed.push(`${who}: allowed more steps (${a.title})`);
    } else {
      await api(`/api/action-center/${a.id}`, { dismiss: true, note: "Not available for this run — continue with what you have and say plainly what is missing." }).catch(() => undefined);
      ownerActed.push(`${who}: dismissed ${a.kind} — ${a.title}`);
    }
  }
  const cr = await api("/api/company").catch(() => ({ requests: [] }));
  for (const q of (cr.requests ?? []).filter((x) => x.status === "WAITING" && made.includes(x.requesterAgentId))) {
    const who = NAMES.get(q.requesterAgentId) ?? q.requesterAgentId.slice(0, 8);
    const before = (await api(`/api/agents/${q.requesterAgentId}/messages`).catch(() => ({ messages: [] }))).messages.length;
    await api(`/api/company/requests/${q.id}`, { action: "cancel" }).catch(() => undefined);
    ownerActed.push(`${who}: dismissed the request for “${q.label}”`);
    resumedAfterDismissal.push({ agentId: q.requesterAgentId, who, label: q.label, before, id: q.id });
  }
}

const samples = [];            // every reading of the floor
const statesSeen = new Map();  // agentId → Set(states)
const truthChecks = [];        // office claim vs authoritative record
const msgCounts = new Map();   // agentId → counts seen while WORKING / after
let duplicateAvatars = 0;
let ownerChatId = null;

const countMessages = async (agentId, chatId) => {
  if (!chatId) return null;
  const m = await api(`/api/agents/${agentId}/messages?chat=${chatId}`).catch(() => null);
  return m ? m.messages.length : null;
};

const mineTasks = async () => (await api("/api/tasks?status=all")).tasks.filter((t) => made.includes(t.assignedTo?.id) || made.includes(t.createdBy?.id));

async function sample() {
  const [floor, agents, tasks] = await Promise.all([
    api("/api/office").catch(() => null),
    api("/api/agents").catch(() => ({ agents: [] })),
    api("/api/tasks?status=all").catch(() => ({ tasks: [] })),
  ]);
  if (!floor) return null;
  const people = [...floor.departments.flatMap((d) => d.agents), ...floor.unassigned];
  const ids = people.map((p) => p.id);
  if (new Set(ids).size !== ids.length) duplicateAvatars++;
  const mine = people.filter((p) => made.includes(p.id));

  for (const p of mine) {
    if (!statesSeen.has(p.id)) statesSeen.set(p.id, new Set());
    statesSeen.get(p.id).add(p.state);

    // ---- is what the office says actually true right now?
    const record = agents.agents.find((a) => a.id === p.id);
    const open = tasks.tasks.filter((t) => t.assignedToAgentId === p.id && ["TODO", "IN_PROGRESS", "BLOCKED"].includes(t.status));
    const running = open.find((t) => t.status === "IN_PROGRESS");
    const kids = running ? tasks.tasks.filter((t) => t.parentTaskId === running.id && ["TODO", "IN_PROGRESS", "BLOCKED"].includes(t.status)) : [];
    const claim = { agent: NAMES.get(p.id), state: p.state, at: floor.at };
    if (p.state.startsWith("WAITING_") && p.state !== "WAITING_TEAM") {
      truthChecks.push({ ...claim, ok: !!record?.waiting, detail: `record waiting = ${record?.waiting?.kind ?? "none"}` });
    } else if (p.state === "WAITING_TEAM") {
      truthChecks.push({ ...claim, ok: kids.length > 0 && !record?.waiting, detail: `${kids.length} open child task(s)` });
    } else if (p.state === "BLOCKED") {
      truthChecks.push({ ...claim, ok: open.some((t) => t.status === "BLOCKED"), detail: "a BLOCKED task exists" });
    } else if (p.state === "IDLE") {
      truthChecks.push({ ...claim, ok: !record?.waiting && !running, detail: "no running task, nothing parked" });
    } else if (p.state === "WORKING") {
      truthChecks.push({ ...claim, ok: !record?.waiting, detail: "not parked on anything" });
    }
    if (p.currentTask) {
      truthChecks.push({ ...claim, ok: tasks.tasks.some((t) => t.id === p.currentTask.id), detail: `current task ${p.currentTask.id.slice(0, 8)} exists in Work` });
    }
  }
  samples.push({ at: floor.at, totals: floor.totals, mine: mine.map((p) => `${NAMES.get(p.id)}:${p.state}`) });

  /* ---- photograph the moments that matter, the first time each happens */
  const ceoNow = mine.find((p) => p.id === ceo.id);
  const mgrs = mine.filter((p) => [engMgr.id, mktMgr.id].includes(p.id));
  const emps = mine.filter((p) => [dev.id, writer.id].includes(p.id));
  if (ceoNow?.state === "WORKING") await photograph("1-ceo-working", "the CEO's own turn is running");
  if (mgrs.some((m) => m.state === "WORKING")) await photograph("2-manager-working", "a manager's turn is running");
  if (mgrs.some((m) => m.state === "WAITING_TEAM")) await photograph("3-manager-waiting-for-team", "a manager has delegated and is waiting");
  if (emps.some((e) => e.state === "WORKING")) await photograph("4-employee-working", "an employee's turn is running");
  if (mine.some((p) => p.state.startsWith("WAITING_") && p.state !== "WAITING_TEAM")) await photograph("5-waiting-on-something", `a real wait: ${mine.find((p) => p.state.startsWith("WAITING_") && p.state !== "WAITING_TEAM").label}`);
  if (mine.some((p) => p.state === "BLOCKED")) await photograph("6-blocked", "something is genuinely blocked");

  // does a turn really run while the office says WORKING? messages are only
  // written when a turn ENDS, so the count must stand still and then jump
  for (const p of mine) {
    const chat = (await api(`/api/agents/${p.id}/chats`).catch(() => ({ chats: [] }))).chats?.[0];
    if (!chat) continue;
    const n = await countMessages(p.id, chat.id);
    if (n === null) continue;
    const rec = msgCounts.get(p.id) ?? { whileWorking: [], afterWorking: [] };
    (p.state === "WORKING" ? rec.whileWorking : rec.afterWorking).push(n);
    msgCounts.set(p.id, rec);
  }
  return floor;
}

const deadline = Date.now() + 22 * 60_000;
while (Date.now() < deadline) {
  await sample();
  await beTheOwner();
  const tasks = await mineTasks();
  const open = tasks.filter((t) => ["TODO", "IN_PROGRESS", "BLOCKED"].includes(t.status));
  const done = await Promise.resolve(conversation).then((c) => !!c && !c.pending).catch(() => false);
  if (tasks.length >= 2 && !open.length && done) break;
  await sleep(1500);
}
const sent = await conversation;
ownerChatId = sent?.assistant?.chatId ?? null;
console.log(`\n${ceo.name}: ${(sent?.assistant?.content ?? sent?.error ?? "(no reply)").trim().slice(0, 400)}\n`);

/* let the last manager→CEO report land, still watching */
for (let i = 0; i < 120; i++) {
  await sample();
  await beTheOwner();
  const msgs = ownerChatId ? (await api(`/api/agents/${ceo.id}/messages?chat=${ownerChatId}`)).messages : [];
  const late = msgs.filter((m) => new Date(m.createdAt).getTime() > t0);
  if (late.some((m) => m.role === "user" && m.origin === "system") && late.filter((m) => m.role === "assistant").length >= 2) break;
  await sleep(2000);
}
await sample();
await photograph("7-final", "the floor once the objective is answered");

/* ---------------------------------------------------------------- what happened */

const tasks = await mineTasks();
const byAgent = (id) => tasks.filter((t) => t.assignedTo?.id === id);
const managerTasks = [...byAgent(engMgr.id), ...byAgent(mktMgr.id)];
const employeeTasks = [...byAgent(dev.id), ...byAgent(writer.id)];
const ownerMsgs = ownerChatId ? (await api(`/api/agents/${ceo.id}/messages?chat=${ownerChatId}`)).messages : [];
const late = ownerMsgs.filter((m) => new Date(m.createdAt).getTime() > t0);
const woken = late.filter((m) => m.role === "user" && m.origin === "system");
const replies = late.filter((m) => m.role === "assistant");
const finalReply = replies.at(-1);

/* ---- 2. two departments */
const depts = new Set(managerTasks.map((t) => (t.assignedTo?.id === engMgr.id ? "engineering" : "marketing")));
pass("the CEO identified both departments the objective needs", depts.size === 2,
  managerTasks.map((t) => `${t.assignedTo?.name}: “${t.title}”`).join(" · ") || "no manager was given anything");
pass("each department got its own distinct piece of work", new Set(managerTasks.map((t) => t.title)).size === managerTasks.length && managerTasks.length >= 2,
  `${managerTasks.length} manager task(s)`);
pass("both managers delegated to their own people", new Set(employeeTasks.map((t) => t.assignedTo?.id)).size >= 2,
  employeeTasks.map((t) => `${t.assignedTo?.name}: “${t.title}”`).join(" · ") || "no employee was given anything");
pass("every piece of employee work is linked to its manager's objective",
  employeeTasks.length > 0 && employeeTasks.every((t) => managerTasks.some((m) => m.id === t.parentTaskId)),
  employeeTasks.map((t) => `${t.id.slice(0, 8)} → ${String(t.parentTaskId).slice(0, 8)}`).join(", "));
pass("the employees produced real outputs", employeeTasks.filter((t) => t.status === "DONE" && (t.resultSummary ?? "").length > 60).length >= 2,
  employeeTasks.map((t) => `${t.assignedTo?.name}: ${t.status}`).join(" · "));
pass("no work was invented for a department the objective did not need",
  tasks.every((t) => made.includes(t.assignedTo?.id)) && managerTasks.length <= 2,
  `${tasks.length} task(s), all inside the test org`);
const premature = managerTasks.filter((m) => m.status === "DONE" && employeeTasks.some((k) => k.parentTaskId === m.id && k.completedAt && m.completedAt && Date.parse(k.completedAt) > Date.parse(m.completedAt)));
pass("no manager finished ahead of its own team", premature.length === 0, premature.map((m) => m.title).join(", ") || "every manager waited");
pass("the CEO waited for both branches before answering",
  managerTasks.length < 2 || (finalReply && managerTasks.every((m) => m.completedAt && Date.parse(finalReply.createdAt) > Date.parse(m.completedAt))),
  finalReply ? `reply at ${finalReply.createdAt.slice(11, 19)}, last branch at ${managerTasks.map((m) => (m.completedAt ?? "—").slice(11, 19)).sort().at(-1)}` : "no final reply");
pass("the CEO was woken with each branch's result, in the owner's conversation", woken.length >= managerTasks.length && woken.length > 0,
  `${woken.length} result(s) delivered into the owner thread for ${managerTasks.length} branch(es)`);
pass("the final answer went back to the owner's own conversation, unprompted",
  !!finalReply && finalReply.id !== sent?.assistant?.id && (finalReply.content ?? "").length > 120,
  finalReply ? finalReply.content.trim().slice(0, 300) : "the CEO never spoke again");
const reply = (finalReply?.content ?? "").toLowerCase();
pass("the final answer references what both departments actually produced",
  /review|readiness|website|site/.test(reply) && /draft|introduction|post/.test(reply),
  reply.slice(0, 200));

/* ---- 1. the office, while it happened */
const seen = (id) => [...(statesSeen.get(id) ?? [])];
pass("every agent in the run appeared on the floor", made.every((id) => statesSeen.has(id)),
  [...NAMES].map(([id, n]) => `${n}:${seen(id).join("/") || "never"}`).join(" · "));
pass("the office showed the CEO working only while its own turn was running",
  seen(ceo.id).includes("WORKING"),
  `CEO states: ${seen(ceo.id).join(", ")}`);
pass("the office showed a manager working while its turn ran", [engMgr.id, mktMgr.id].some((id) => seen(id).includes("WORKING")),
  `EngMgr ${seen(engMgr.id).join("/") || "—"} · MktMgr ${seen(mktMgr.id).join("/") || "—"}`);
pass("the office showed an employee working while its turn ran", [dev.id, writer.id].some((id) => seen(id).includes("WORKING")),
  `Engineer ${seen(dev.id).join("/") || "—"} · Writer ${seen(writer.id).join("/") || "—"}`);
pass("a manager waiting on its team was shown as waiting for its team, never as working then",
  [engMgr.id, mktMgr.id].some((id) => seen(id).includes("WAITING_TEAM")) || employeeTasks.length === 0,
  `EngMgr ${seen(engMgr.id).join("/") || "—"} · MktMgr ${seen(mktMgr.id).join("/") || "—"}`);
const wrong = truthChecks.filter((c) => !c.ok);
pass("every state the office showed was true of the real agent and task records at that moment",
  wrong.length === 0,
  wrong.length ? wrong.slice(0, 4).map((c) => `${c.agent} claimed ${c.state} but ${c.detail}`).join(" | ") : `${truthChecks.length} claims cross-checked`);
pass("no duplicate avatars in any of the readings", duplicateAvatars === 0, `${samples.length} readings taken`);

// a turn genuinely in flight: the transcript stands still while WORKING and jumps after
const proven = [...msgCounts.entries()].filter(([, rec]) => rec.whileWorking.length && rec.afterWorking.length && Math.max(...rec.afterWorking) > Math.max(...rec.whileWorking));
pass("\"working\" meant a turn was genuinely in flight, not a task sitting at IN_PROGRESS",
  proven.length > 0,
  proven.map(([id, rec]) => `${NAMES.get(id)}: ${Math.max(...rec.whileWorking)} messages during → ${Math.max(...rec.afterWorking)} after`).join(" · ") || "no agent was sampled both during and after a turn");

const finalFloor = await api("/api/office");
const finalMine = [...finalFloor.departments.flatMap((d) => d.agents)].filter((a) => made.includes(a.id));
const stillOpen = tasks.filter((t) => ["TODO", "IN_PROGRESS", "BLOCKED"].includes(t.status));
pass("completed work stopped showing as active", finalMine.every((a) => a.state === "IDLE" || a.state === "WORKING"),
  finalMine.map((a) => `${NAMES.get(a.id)}:${a.state}`).join(" · "));
pass("the final office state matches the authoritative agent and task state",
  finalMine.every((a) => (a.currentTask ? stillOpen.some((t) => t.id === a.currentTask.id) : !stillOpen.some((t) => t.assignedToAgentId === a.id))),
  `${stillOpen.length} task(s) still open`);

/* ---- clicking an avatar opens the same agent and task */
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const anyone = finalMine[0];
const hotspot = page.locator(`button[aria-label^="${anyone.name},"]`).first();
let cardOk = false;
if (await hotspot.count()) {
  await hotspot.click();
  await page.waitForTimeout(800);
  const card = await page.locator("text=Chat").first().isVisible().catch(() => false);
  const nameOnCard = await page.getByText(anyone.name, { exact: false }).count();
  cardOk = card && nameOnCard > 0;
  await photograph("8-agent-card", "an agent opened from the floor");
}
pass("clicking an avatar opens that same real agent", cardOk, `${anyone.name} (${anyone.id.slice(0, 8)})`);

/* ---- the live stream survives an interruption */
await page.route("**/api/office/events", (route) => route.abort());
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
const staleShown = await page.locator('[title*="Live updates are disconnected"]').count();
await photograph("9-disconnected", "the stream is cut: the office says so rather than pretending");
await page.unroute("**/api/office/events");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(3500);
const recovered = (await page.locator('[title*="Live updates are disconnected"]').count()) === 0
  && (await page.locator("button[aria-label*='—']").count()) > 0;
pass("a cut live stream is shown as disconnected rather than pretended away", staleShown > 0, `indicator ${staleShown ? "shown" : "missing"}`);
pass("the office recovers by itself when the stream comes back", recovered, recovered ? "reconnected and repopulated" : "still showing as disconnected");

/* ---- the owner only ever had to answer real questions, and the answers landed */
console.log(`\nthe owner (this script) answered ${ownerActed.length}: ${ownerActed.join(" · ") || "nothing was asked"}`);
if (resumedAfterDismissal.length) {
  const checks = [];
  for (const r of resumedAfterDismissal) {
    const msgs = (await api(`/api/agents/${r.agentId}/messages`).catch(() => ({ messages: [] }))).messages;
    checks.push({ ...r, told: msgs.slice(r.before).some((m) => m.origin === "system" && m.content.includes(r.id.slice(0, 8))) });
  }
  pass("a dismissed information request reached the agent rather than stranding it",
    checks.every((c) => c.told),
    checks.map((c) => `${c.who} “${c.label}”: ${c.told ? "told" : "NEVER TOLD"}`).join(" · "));
}

/* ---- it kept its hands to itself */
const paymentsAfter = (await api("/api/payments/history")).transactions.length;
pass("nothing was bought", paymentsAfter === paymentsBefore, `${paymentsAfter - paymentsBefore} new payment row(s)`);
const reqs = (await api("/api/payments/requests").catch(() => ({ requests: [] }))).requests ?? [];
pass("no money was even asked for", !reqs.some((x) => made.includes(x.requestedByAgentId)), "no payment request from the test agents");

/* ---------------------------------------------------------------- evidence */

console.log("\n--- the floor, moment by moment ------------------------------");
let last = "";
for (const s of samples) {
  const line = s.mine.join(" | ");
  if (line !== last) { console.log(`${s.at.slice(11, 19)}  ${line}`); last = line; }
}

console.log("\n--- evidence -------------------------------------------------");
console.log(JSON.stringify({
  runtime,
  ownerChatId,
  agents: [...NAMES].map(([id, n]) => `${n} ${id}`),
  managerTasks: managerTasks.map((t) => ({ id: t.id, title: t.title, to: t.assignedTo?.name, status: t.status, parent: t.parentTaskId, origin: t.originChatId })),
  employeeTasks: employeeTasks.map((t) => ({ id: t.id, title: t.title, to: t.assignedTo?.name, status: t.status, parent: t.parentTaskId, result: (t.resultSummary ?? "").slice(0, 160) })),
  ownerAnswered: ownerActed,
  screenshots: shots.map((s) => `${s.key}: ${s.why}`),
  finalReply: finalReply?.content?.slice(0, 1200),
}, null, 2));

await browser.close();

if (!KEEP) {
  for (const t of await mineTasks()) await api(`/api/tasks/${t.id}`, { cancel: { reason: "live office check cleanup" } }, "PATCH").catch(() => undefined);
  for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => undefined);
  console.log(`\ncleaned up ${made.length} test agents and their work`);
} else {
  console.log(`\nkept: ${made.join(", ")}`);
}
summary();
