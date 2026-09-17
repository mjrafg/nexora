#!/usr/bin/env node
/* ------------------------------------------------------------------
   Visual QA: the office and the work board, at the widths people
   actually use, plus the states that are easy to get wrong — an agent
   opened from the floor, the list views, and reduced motion.

   It signs in through the API rather than typing into the form, so no
   password is ever entered into a page.

   Usage: node scripts/screenshots.mjs [baseUrl] [outDir]
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
const OUT = process.argv[3] || "shots";
fs.mkdirSync(OUT, { recursive: true });

const r = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.NEXORA_USER || "mjrafg", password: requirePassword() }),
});
if (!r.ok) throw new Error(`login failed: ${r.status}`);
const [name, value] = (r.headers.get("set-cookie") || "").split(";")[0].split("=");
const url = new URL(BASE);
const browser = await chromium.launch();

async function open(width, height, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, ...opts });
  await ctx.addCookies([{ name, value, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: url.protocol === "https:" }]);
  return ctx;
}
const shot = async (page, file) => { await page.screenshot({ path: `${OUT}/${file}.png` }); console.log(`${OUT}/${file}.png`); };

for (const [w, h] of [[1500, 980], [1280, 860], [800, 900], [400, 820]]) {
  const ctx = await open(w, h);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await shot(page, `office-${w}`);
  await page.goto(`${BASE}/work`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await shot(page, `work-${w}`);
  await ctx.close();
}

{
  const ctx = await open(1500, 980);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/scene`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const labels = await page.locator("button[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  console.log("on the floor:", labels.filter((l) => l?.includes("—")).slice(0, 8).join(" | "));
  for (const want of ["Blocked", "Waiting", "Working", "Available"]) {
    const target = page.locator(`button[aria-label*="— ${want}"]`).first();
    if (await target.count()) { await target.click(); await page.waitForTimeout(800); await shot(page, `office-agent-${want.toLowerCase()}`); break; }
  }
  for (const view of ["Directory", "Org chart"]) {
    await page.getByRole("button", { name: view }).click();
    await page.waitForTimeout(700);
    await shot(page, `office-${view.toLowerCase().replace(/\s+/g, "-")}`);
  }
  await ctx.close();
}

{
  const ctx = await open(1500, 980, { reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/scene`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await shot(page, "office-reduced-motion");
  await ctx.close();
}
await browser.close();
