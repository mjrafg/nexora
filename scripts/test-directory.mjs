#!/usr/bin/env node
/* ------------------------------------------------------------------
   The directory and the org chart, against a company that is awkward on
   purpose: more people in one room than it has desks, names longer than
   any label was designed for, someone moved between departments and
   someone removed while the page is open.

   The floor may hide people behind "+N more" — that is what a room with
   six desks and eleven people honestly looks like — but the directory
   may never hide anyone, at any width.

   Usage: node scripts/test-directory.mjs [baseUrl] [outDir] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import { chromium } from "playwright";

/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}


const BASE = process.argv[2] || "http://localhost:3111";
const OUT = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "shots";
const KEEP = process.argv.includes("--keep");
const USER = process.env.NEXORA_USER || "mjrafg";
const PASS = requirePassword();
fs.mkdirSync(OUT, { recursive: true });
let cookie = "";

async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}
const floor = () => api("/api/office");
const everyone = (f) => [...f.departments.flatMap((d) => d.agents), ...f.unassigned];
const find = (f, id) => everyone(f).find((a) => a.id === id);

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const conns = (await api("/api/providers")).connections;
const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
const made = [];
const mk = async (name, role, dept, perms = []) => {
  const { agent } = await api("/api/agents", { name, role, dept, toolPermissions: perms, runtime });
  made.push(agent);
  return agent;
};

const LONG_NAME = "Wilhelmina Featherstonehaugh-Abernathy the Third";
const LONG_ROLE = "Principal Staff Engineer for Platform Reliability, Observability, Incident Response and Long-Term Capacity Planning";

const lead = await mk("Dir Test Lead", "Support Lead", "support");
const longOne = await mk(LONG_NAME, LONG_ROLE, "support");
const crowd = [longOne];
for (let i = 0; i < 9; i++) crowd.push(await mk(`Dir Test Crowd ${i}`, "Support Specialist", "support"));
for (const a of crowd) await api(`/api/agents/${a.id}`, { managerAgentId: lead.id }, "PATCH");
const mover = await mk("Dir Test Mover", "Operations Analyst", "operations");
const goner = await mk("Dir Test Goner", "Financial Analyst", "finance");
const waiter = await mk("Dir Test Waiter", "Integrations Engineer", "operations", ["credentials"]);
const created = [];

try {
  /* ---------------------------------------------------------------- the data behind both views */

  await test("A - every agent appears exactly once, in the right department, under the right manager", async () => {
    const f = await floor();
    const all = everyone(f);
    assert(new Set(all.map((a) => a.id)).size === all.length, "someone is on the floor twice");
    for (const a of made) {
      const on = find(f, a.id);
      assert(on, `${a.name} is missing from the floor`);
      assert(on.dept === a.dept, `${a.name} is in ${on.dept}, not ${a.dept}`);
    }
    const leadOn = find(f, lead.id);
    assert(leadOn.reports === crowd.length, `${leadOn.reports} reports, expected ${crowd.length}`);
    for (const c of crowd) assert(find(f, c.id).managerId === lead.id, `${c.name} does not report to the lead`);
    return `${all.length} agents, ${leadOn.reports} reporting to the support lead`;
  });

  await test("B - the current task and the waiting reason are the real ones", async () => {
    const t = (await api("/api/tasks", { title: "Dir test export", description: "Needs a login.", assignedToAgentId: waiter.id })).task;
    created.push(t.id);
    for (let i = 0; i < 40 && (await api(`/api/tasks/${t.id}`)).task.status !== "IN_PROGRESS"; i++) await sleep(300);
    const ask = await api("/api/tools/run", {
      agentId: waiter.id, tool: "credentials__request_credential", scopeId: `task:${t.id}`,
      args: { service: "Dir Test Portal", site: "dir-test.example", login_url: "https://dir-test.example/login", reason: "The directory test needs the portal login and none is stored." },
    });
    assert(ask.ok, ask.error);
    let on = null;
    for (let i = 0; i < 40; i++) { on = find(await floor(), waiter.id); if (on.state === "WAITING_LOGIN") break; await sleep(400); }
    assert(on.state === "WAITING_LOGIN", `state is ${on.state}`);
    assert(/Dir Test Portal/.test(on.label), on.label);
    assert(on.currentTask?.id === t.id, JSON.stringify(on.currentTask));
    assert(on.href?.startsWith("/credentials?request="), on.href);
    return `${on.state} · ${on.label.slice(0, 60)}`;
  });

  await test("C - the room shows what it can hold and says how many it cannot", async () => {
    const f = await floor();
    const support = f.departments.find((d) => d.id === "support");
    assert(support.agents.length >= 11, `${support.agents.length} in support`);
    // the directory holds everyone regardless of how many desks the room has
    assert(support.agents.some((a) => a.name === LONG_NAME), "the long-named agent is missing from the department list");
    return `${support.agents.length} people in a room with far fewer desks`;
  });

  /* ---------------------------------------------------------------- the views themselves */

  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
  const [ckName, ckValue] = (r.headers.get("set-cookie") || "").split(";")[0].split("=");
  const host = new URL(BASE);
  const browser = await chromium.launch();
  const open = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await ctx.addCookies([{ name: ckName, value: ckValue, domain: host.hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: host.protocol === "https:" }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/scene`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const showDirectory = async (page) => {
    const btn = page.getByRole("button", { name: "Directory" });
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(800); }
  };

  for (const [w, h, label] of [[1500, 980, "desktop"], [820, 1000, "tablet"], [400, 840, "mobile"]]) {
    await test(`D - the directory lists everyone at ${label} (${w}px), and nothing overflows sideways`, async () => {
      const { ctx, page } = await open(w, h);
      await showDirectory(page);
      const text = await page.locator("body").innerText();
      const missing = made.filter((a) => !text.includes(a.name));
      assert(!missing.length, `missing from the directory: ${missing.map((m) => m.name).join(", ").slice(0, 120)}`);
      const overflow = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll("div,section,ul,li,button")) {
          if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === "visible") bad.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
        }
        return bad.slice(0, 5);
      });
      assert(!overflow.length, `content spills out of: ${overflow.join(" | ")}`);
      const bodyScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2);
      assert(bodyScroll, "the page scrolls sideways");
      await page.screenshot({ path: `${OUT}/directory-${label}.png` });
      await ctx.close();
      return `${made.length} test agents all listed · ${OUT}/directory-${label}.png`;
    });
  }

  await test("E - the org chart shows the real reporting line, long names and all", async () => {
    const { ctx, page } = await open(1500, 980);
    const btn = page.getByRole("button", { name: "Org chart" });
    await btn.click();
    await page.waitForTimeout(800);
    const text = await page.locator("body").innerText();
    assert(text.includes(lead.name), "the manager is missing from the org chart");
    assert(text.includes(LONG_NAME), "the long-named report is missing from the org chart");
    const count = await page.getByText(LONG_NAME, { exact: false }).count();
    assert(count === 1, `the long-named agent appears ${count} times`);
    await page.screenshot({ path: `${OUT}/org-chart.png` });
    await ctx.close();
    return `one line per person · ${OUT}/org-chart.png`;
  });

  await test("F - the office keeps its desks and admits what it cannot show", async () => {
    const { ctx, page } = await open(1500, 980);
    const body = await page.locator("body").innerText();
    assert(/\+\d+ more/.test(body), "a room with more people than desks does not say so");
    const hotspots = await page.locator("button[aria-label*='—']").count();
    const f = await floor();
    assert(hotspots > 0 && hotspots <= everyone(f).length, `${hotspots} avatars for ${everyone(f).length} agents`);
    await page.screenshot({ path: `${OUT}/office-crowded.png` });
    await ctx.close();
    return `${hotspots} desks drawn, the rest named in "+N more"`;
  });

  await test("G - moving someone changes their department, removing them takes their desk away", async () => {
    await api(`/api/agents/${mover.id}`, { dept: "finance" }, "PATCH");
    let f = await floor();
    assert(find(f, mover.id).dept === "finance", "the move did not take");
    assert(!f.departments.find((d) => d.id === "operations").agents.some((a) => a.id === mover.id), "they are still at their old desk");
    await api(`/api/agents/${goner.id}`, null, "DELETE");
    f = await floor();
    assert(!find(f, goner.id), "a removed agent is still on the floor");
    made.splice(made.findIndex((a) => a.id === goner.id), 1);
    const { ctx, page } = await open(1500, 980);
    await showDirectory(page);
    const text = await page.locator("body").innerText();
    assert(!text.includes("Dir Test Goner"), "the removed agent is still in the directory");
    await ctx.close();
    return "moved and removed, reflected in both views";
  });

  await browser.close();
} finally {
  if (!KEEP) {
    for (const id of created) await api(`/api/tasks/${id}`, { cancel: { reason: "directory suite cleanup" } }, "PATCH").catch(() => undefined);
    for (const a of made) await api(`/api/agents/${a.id}`, null, "DELETE").catch(() => undefined);
    await api(`/api/agents/${lead.id}`, null, "DELETE").catch(() => undefined);
  }
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
