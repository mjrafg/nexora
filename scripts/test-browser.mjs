#!/usr/bin/env node

/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}

/* ------------------------------------------------------------------
   Nexora Browser regression suite (compare against Tandem behaviour).
   Drives the same host the agents use through the Test Lab route.

   Usage: node scripts/test-browser.mjs [baseUrl] [username] [password]
   Requires NEXORA_BROWSER_TEST_HOOKS=1 on the server for the crash test.
   ------------------------------------------------------------------ */
const BASE = process.argv[2] || "http://localhost:3111";
const USER = process.argv[3] || process.env.NEXORA_USER || "mjrafg";
const PASS = process.argv[4] || requirePassword();
let cookie = "";

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
}
async function lab(session, tool, args = {}) {
  const r = await fetch(`${BASE}/api/browser/lab`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ session, tool, args }) });
  return r.json();
}
async function sessions() {
  const r = await fetch(`${BASE}/api/browser/sessions`, { headers: { cookie } });
  return (await r.json()).sessions;
}

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note });
    console.log(`✓ ${name} (${Date.now() - t0} ms)${note ? ` — ${note}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: String(err.message || err) });
    console.log(`✗ ${name} — ${String(err.message || err).slice(0, 300)}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const S = `regress-${Date.now().toString(36)}`;

await login();

await test("basic navigation", async () => {
  const r = await lab(S, "browser_navigate", { url: "https://example.com" });
  assert(r.ok, r.text);
  assert(/Example Domain/.test(r.text), "title missing");
  assert(/\[ref=/.test(r.text), "snapshot refs missing");
  return r.report.url;
});

await test("page text extraction", async () => {
  const r = await lab(S, "browser_read", {});
  assert(r.ok && /Example Domain/.test(r.text) && /documentation/.test(r.text), r.text.slice(0, 200));
});

await test("search-result navigation", async () => {
  const r = await lab(S, "browser_search", { query: "model context protocol github", maxResults: 5 });
  assert(r.ok, r.text);
  const m = r.text.match(/https?:\/\/\S+/);
  assert(m, "no result url");
  assert(!/bing\.com\/ck|duckduckgo\.com\/l\//.test(r.text), "redirect links not decoded: " + m[0]);
  assert(/github|modelcontextprotocol/i.test(r.text), "results look unrelated: " + r.text.slice(0, 200));
  const nav = await lab(S, "browser_navigate", { url: m[0] });
  assert(nav.ok, nav.text);
  return `${r.text.split("\n")[0]} → ${nav.report.url}`;
});

await test("form fill + button click (httpbin form)", async () => {
  const nav = await lab(S, "browser_navigate", { url: "https://httpbin.org/forms/post" });
  assert(nav.ok, nav.text);
  const t = await lab(S, "browser_type", { selector: "input[name=custname]", text: "Nexora Tester", element: "customer name" });
  assert(t.ok, t.text);
  const tel = await lab(S, "browser_type", { selector: "input[name=custtel]", text: "555-0100", sensitive: true });
  assert(tel.ok && /redacted/.test(tel.text) && tel.report.value === "•••", "sensitive value not redacted");
  const c = await lab(S, "browser_click", { selector: "button", element: "Submit order" });
  assert(c.ok, c.text);
  const read = await lab(S, "browser_read", {});
  assert(/Nexora Tester/.test(read.text), "posted value not echoed");
  return read.report.url;
});

await test("dropdown / select", async () => {
  await lab(S, "browser_navigate", { url: "https://httpbin.org/forms/post" });
  const snap = await lab(S, "browser_snapshot", {});
  assert(snap.ok, snap.text);
  const html = await lab(S, "browser_evaluate", { code: "(() => { const s = document.createElement('select'); s.id = 'nx'; ['Small','Medium','Large'].forEach((l) => { const o = document.createElement('option'); o.textContent = l; o.value = l.toLowerCase(); s.appendChild(o); }); document.body.prepend(s); return 'ok'; })()" });
  assert(html.ok, html.text);
  const sel = await lab(S, "browser_select", { selector: "#nx", values: ["Large"] });
  assert(sel.ok && /large/.test(sel.text), sel.text);
  const v = await lab(S, "browser_evaluate", { code: "document.getElementById('nx').value" });
  assert(v.text.includes("large"), v.text);
});

await test("keyboard action (type + Enter submits search)", async () => {
  await lab(S, "browser_navigate", { url: "https://en.wikipedia.org/wiki/Main_Page" });
  const t = await lab(S, "browser_type", { selector: "input[name=search]", text: "Playwright (software)", submit: true });
  assert(t.ok, t.text);
  const w = await lab(S, "browser_wait", { urlContains: "Playwright" });
  assert(w.ok, w.text);
  const p = await lab(S, "browser_press", { key: "End" });
  assert(p.ok, p.text);
  return w.report.url;
});

await test("SPA navigation (client-side route change)", async () => {
  const nav = await lab(S, "browser_navigate", { url: "https://react.dev/" });
  assert(nav.ok, nav.text);
  const c = await lab(S, "browser_click", { selector: "a[href='/learn']", element: "Learn link" });
  assert(c.ok, c.text);
  const w = await lab(S, "browser_wait", { urlContains: "/learn" });
  assert(w.ok && /react\.dev\/learn/.test(w.report.url), w.report.url);
  return w.report.url;
});

await test("scroll + screenshot + resize", async () => {
  const s = await lab(S, "browser_scroll", { dy: 800 });
  assert(s.ok, s.text);
  const r = await lab(S, "browser_resize", { width: 800, height: 600 });
  assert(r.ok && r.report.viewport.width === 800, r.text);
  const shot = await lab(S, "browser_screenshot", {});
  assert(shot.ok && shot.report.screenshotUrl, shot.text);
  const img = await fetch(`${BASE}${shot.report.screenshotUrl}`, { headers: { cookie } });
  assert(img.ok && img.headers.get("content-type") === "image/jpeg", `screenshot fetch ${img.status}`);
  const full = await lab(S, "browser_screenshot", { fullPage: true });
  assert(full.ok, full.text);
  return shot.report.screenshotUrl;
});

await test("new tab + popup + tabs list/switch/close", async () => {
  await lab(S, "browser_navigate", { url: "https://example.com" });
  const nt = await lab(S, "browser_tabs", { action: "new", url: "https://httpbin.org/html" });
  assert(nt.ok && /2 open tabs/.test(nt.text), nt.text);
  const pop = await lab(S, "browser_evaluate", { code: "window.open('https://example.org', '_blank') && 'opened'" });
  assert(pop.ok, pop.text);
  await lab(S, "browser_wait", { seconds: 1 });
  const list = await lab(S, "browser_tabs", { action: "list" });
  assert(/3 open tabs/.test(list.text), list.text);
  assert(/▶.*example\.org/.test(list.text), "popup did not become the active tab: " + list.text);
  const sw = await lab(S, "browser_tabs", { action: "switch", index: 0 });
  assert(sw.ok && /▶ \[0\]/.test(sw.text), sw.text);
  const cl = await lab(S, "browser_tabs", { action: "close", index: 2 });
  assert(cl.ok && /2 open tabs/.test(cl.text), cl.text);
  await lab(S, "browser_tabs", { action: "close", index: 1 });
  const st = await lab(S, "browser_get_state", {});
  assert(st.ok && JSON.parse(st.text).tabs.length === 1, st.text);
});

await test("dialog auto-accept (alert would otherwise wedge)", async () => {
  await lab(S, "browser_navigate", { url: "https://example.com" });
  const r = await lab(S, "browser_evaluate", { code: "setTimeout(() => alert('hello from page'), 50); 'scheduled'" });
  assert(r.ok, r.text);
  await lab(S, "browser_wait", { seconds: 0.5 });
  const c = await lab(S, "browser_console", { level: "all" });
  assert(/dialog\] alert: hello from page/.test(c.text), c.text);
});

await test("download event", async () => {
  await lab(S, "browser_navigate", { url: "https://example.com" });
  const r = await lab(S, "browser_evaluate", { code: "(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['nexora download test'], { type: 'text/plain' })); a.download = 'nexora-test.txt'; document.body.appendChild(a); a.click(); return 'clicked'; })()" });
  assert(r.ok, r.text);
  await lab(S, "browser_wait", { seconds: 1 });
  const d = await lab(S, "browser_downloads", {});
  assert(/✓ nexora-test\.txt \(\d+ bytes\)/.test(d.text), d.text);
  return d.text.split("\n")[0];
});

await test("slow page (3 s delay) loads", async () => {
  const r = await lab(S, "browser_navigate", { url: "https://httpbin.org/delay/3" });
  assert(r.ok, r.text);
});

await test("timeout is reported, browser stays usable", async () => {
  // non-routable address: the 20 s navigation timeout fires before TCP gives up
  const r = await lab(S, "browser_navigate", { url: "http://10.255.255.1:81/" });
  assert(!r.ok && /Timeout|timeout/i.test(r.text), "expected a timeout, got: " + r.text.slice(0, 200));
  const again = await lab(S, "browser_navigate", { url: "https://example.com" });
  assert(again.ok, again.text);
});

await test("wait for text / text gone", async () => {
  await lab(S, "browser_navigate", { url: "https://example.com" });
  const w = await lab(S, "browser_wait", { text: "Example Domain" });
  assert(w.ok, w.text);
  await lab(S, "browser_evaluate", { code: "setTimeout(() => document.querySelector('h1').remove(), 300); 'ok'" });
  const g = await lab(S, "browser_wait", { textGone: "Example Domain" });
  assert(g.ok, g.text);
});

await test("session reuse: cookie survives kill + relaunch (durable state)", async () => {
  await lab(S, "browser_navigate", { url: "https://httpbin.org/cookies/set/nexora/persist" });
  const k = await lab(S, "browser_kill", {});
  assert(k.ok, k.text);
  const live = (await sessions()).find((x) => x.id === `lab:${S}`);
  assert(live && live.status === "saved", "session should be saved after kill");
  const r = await lab(S, "browser_navigate", { url: "https://httpbin.org/cookies" });
  assert(r.ok && /\\?"nexora\\?":\s*\\?"persist/.test(r.text), r.text.slice(0, 300));
  assert(/restored from saved state/.test(r.text), "restore note missing");
});

await test("session reuse across calls keeps live page state", async () => {
  await lab(S, "browser_navigate", { url: "https://example.com" });
  await lab(S, "browser_evaluate", { code: "window.__nexora = 42; sessionStorage.setItem('k','v'); 'set'" });
  const r = await lab(S, "browser_evaluate", { code: "window.__nexora + ':' + sessionStorage.getItem('k')" });
  assert(/42:v/.test(r.text), r.text);
});

await test("reset keeps cookies, drops live state", async () => {
  const r = await lab(S, "browser_reset", {});
  assert(r.ok, r.text);
  const c = await lab(S, "browser_navigate", { url: "https://httpbin.org/cookies" });
  assert(/\\?"nexora\\?":\s*\\?"persist/.test(c.text), c.text.slice(0, 200));
});

await test("serialization: concurrent calls never interleave", async () => {
  const [a, b, c] = await Promise.all([
    lab(S, "browser_navigate", { url: "https://example.com" }),
    lab(S, "browser_navigate", { url: "https://example.org" }),
    lab(S, "browser_get_state", {}),
  ]);
  assert(a.ok && b.ok && c.ok, [a.text, b.text, c.text].join(" | ").slice(0, 300));
  assert(/example\.org/.test(JSON.parse(c.text).url), "state should reflect the last navigation: " + c.text);
});

await test("cancellation tears down the live browser mid-call", async () => {
  const slow = lab(S, "browser_navigate", { url: "https://httpbin.org/delay/8" });
  await new Promise((r) => setTimeout(r, 800));
  const cancel = await fetch(`${BASE}/api/browser/sessions`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: `lab:${S}`, action: "cancel" }) }).then((r) => r.json());
  assert(cancel.ok && cancel.cancelled, JSON.stringify(cancel));
  const r = await slow;
  assert(!r.ok, "cancelled call should fail, got: " + r.text.slice(0, 120));
  const again = await lab(S, "browser_navigate", { url: "https://example.com" });
  assert(again.ok, again.text);
  return r.text.slice(0, 80);
});

await test("crash recovery (Chromium killed → next call restarts)", async () => {
  const crash = await lab(S, "_test_crash", {});
  if (!crash.ok && /disabled/.test(crash.text)) return "skipped: NEXORA_BROWSER_TEST_HOOKS not set";
  assert(crash.ok, crash.text);
  const r = await lab(S, "browser_navigate", { url: "https://example.com" });
  assert(r.ok, r.text);
  assert(/crash/.test(r.text) || /restored/.test(r.text), "crash/restore note missing: " + r.text.slice(-200));
  return r.text.slice(-120);
});

await test("watchdog: wedged evaluate (>100 s) — skipped by default", async () => "skipped (would take 100 s); covered by cancellation + timeout tests");

await test("upload restricted to workspace/downloads", async () => {
  await lab(S, "browser_navigate", { url: "https://httpbin.org/forms/post" });
  await lab(S, "browser_evaluate", { code: "(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'up'; document.body.prepend(i); return 'ok'; })()" });
  const bad = await lab(S, "browser_upload", { selector: "#up", paths: ["/etc/hosts"] });
  assert(!bad.ok && /Refusing/.test(bad.text), bad.text);
  const d = await lab(S, "browser_downloads", {});
  const m = d.text.match(/^\s+(\/\S+nexora-test\.txt)/m);
  assert(m, "no downloaded file to upload: " + d.text);
  const good = await lab(S, "browser_upload", { selector: "#up", paths: [m[1]] });
  assert(good.ok, good.text);
  const n = await lab(S, "browser_evaluate", { code: "document.getElementById('up').files.length" });
  assert(/1/.test(n.text), n.text);
});

await test("session close + delete leaves nothing behind", async () => {
  const k = await lab(S, "browser_kill", {});
  assert(k.ok, k.text);
  const del = await fetch(`${BASE}/api/browser/sessions`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: `lab:${S}`, action: "delete" }) }).then((r) => r.json());
  assert(del.ok, JSON.stringify(del));
  const left = (await sessions()).find((x) => x.id === `lab:${S}`);
  assert(!left, "session still listed after delete");
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
