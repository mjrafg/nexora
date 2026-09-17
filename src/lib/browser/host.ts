/* ------------------------------------------------------------------
   Nexora Browser host — ported/adapted from Tandem's engine/browserHost.ts.

   The SERVER owns every internal browser, keyed by a canonical session key
   (by default one per agent: "agent:<id>"), so browser continuity belongs to
   the Nexora agent, never to an individual AI runtime invocation:

     same key                → one live Chromium context across turns/runtimes
     different key           → separate instance, nothing shared

   Live state (open page, scroll, SPA state, sessionStorage) survives as long
   as the instance lives; durable state (cookies/localStorage via Playwright
   storageState, plus the last URL/scroll/tabs) is checkpointed under
   DATA_DIR/browser/ and restored when an instance is lazily recreated — after
   a kill, an idle reap, a crash, or an app restart. What cannot survive a dead
   process (JS heap, modals, sessionStorage) is honestly reported as reset.

   Reliability behaviour preserved from Tandem, with the reason for each:
     - strict per-instance serialization (two callers never interleave CDP)
     - 100 s call watchdog that DISPOSES a wedged instance so the next call
       self-heals instead of queueing behind the stuck operation
     - "disposed" instances never relaunch (a queued call gets a clean error)
     - partially launched browsers are CLOSED, not forgotten (no orphans)
     - stale 'disconnected' listeners of a replaced browser never null out the
       live replacement
     - Playwright signal handlers disabled: Nexora owns process lifecycle so a
       SIGTERM still runs the graceful checkpoint
     - checkpoints re-check `disposed` after awaits so a deleted session's
       file is never resurrected
     - popups/new pages become the active page; a closed active page adopts
       another open page before creating a new one
     - screenshots at CSS scale, JPEG, harder compression for full-page
   ------------------------------------------------------------------ */

import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Download, Page } from "playwright";
import { DATA_DIR, WORKSPACES_DIR, readDb } from "@/lib/store/db";
import { credentialValues } from "@/lib/mcp/store";
import { activePaymentSecretStrings, authorizationAllowsCredential } from "@/lib/payments/store";

/* ---------------------------------------------------------------- types */

export type BrowserScope = {
  /** canonical session key, e.g. agent:<agentId> or lab:<name> */
  key: string;
  ownerAgentId: string;
  /** human label for the UI */
  label?: string;
};

export type BrowserReport = {
  action: string;
  detail: string;
  url?: string;
  title?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  ref?: string;
  value?: string;
  screenshotFile?: string;
  screenshotUrl?: string;
  console?: { level: string; text: string }[];
  error?: string;
  status?: "done" | "failed";
};

export type BrowserContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type BrowserToolResult = {
  content?: BrowserContentPart[];
  text?: string;
  isError?: boolean;
  report?: BrowserReport | null;
};

export type BrowserSessionInfo = {
  id: string;
  ownerAgentId: string;
  label: string;
  status: "live" | "saved";
  currentUrl?: string;
  title?: string;
  tabs: number;
  viewport: { width: number; height: number };
  downloads: number;
  createdAt: number;
  lastActivityAt: number;
  busy: boolean;
};

type DownloadRecord = { file: string; path: string; url: string; suggestedFilename: string; bytes: number; at: number; status: "saved" | "failed"; error?: string };

interface BrowserInstance {
  key: string;
  ownerAgentId: string;
  label: string;
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  dsr: number;
  viewport: { width: number; height: number };
  shotSeq: number;
  consoleBuf: { level: string; text: string; at: number }[];
  ariaRefWorks: boolean;
  /** pending one-shot notes appended to the next tool reply */
  notes: string[];
  downloads: DownloadRecord[];
  createdAt: number;
  lastUsed: number;
  lastSaved: number;
  /** once torn down, this object must never relaunch — a queued call gets a clean error */
  disposed: boolean;
  /** serializes tool calls on this instance — two callers can never interleave */
  chain: Promise<unknown>;
  inFlight: number;
}

/* ---------------------------------------------------------------- constants */

// neutral: whether anything is actually restored is stated by ensurePage's
// restore branch, which alone knows if a durable checkpoint existed
const CRASH_NOTE = " (note: the browser had crashed and was restarted; live page state was reset)";
const IDLE_MS = 30 * 60_000; // release live Chromium after 30 idle minutes
const CHECKPOINT_MS = 60_000; // durable checkpoint at most once a minute per instance
const REAPER_TICK_MS = 5 * 60_000;
const CALL_WATCHDOG_MS = 100_000; // a wedged handler is force-recovered before the proxy's 120s timeout

const instances = new Map<string, BrowserInstance>();

export const BROWSER_STATE_DIR = path.join(DATA_DIR, "browser");
export const SHOTS_DIR = path.join(DATA_DIR, "shots");
export const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");

function ensureDirs() {
  fs.mkdirSync(BROWSER_STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

/** filenames derive ONLY from sanitized keys — no path traversal, ever */
export function safeKey(key: string): string {
  return String(key).replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
}

function stateFile(key: string): string {
  return path.join(BROWSER_STATE_DIR, `${safeKey(key)}.json`);
}

function getInstance(scope: BrowserScope): BrowserInstance {
  let inst = instances.get(scope.key);
  if (!inst || inst.disposed) {
    inst = {
      key: scope.key,
      ownerAgentId: scope.ownerAgentId,
      label: scope.label ?? scope.key,
      browser: null, context: null, page: null,
      dsr: 1, viewport: { width: 1280, height: 800 },
      shotSeq: 0, consoleBuf: [], ariaRefWorks: true,
      notes: [], downloads: [],
      createdAt: Date.now(), lastUsed: Date.now(), lastSaved: 0, disposed: false,
      chain: Promise.resolve(), inFlight: 0,
    };
    instances.set(scope.key, inst);
  } else if (scope.label && inst.label !== scope.label) inst.label = scope.label;
  return inst;
}

/* ---------------------------------------------------------------- durable state */

interface DurableState {
  key: string;
  ownerAgentId: string;
  label: string;
  storageState?: unknown;
  url?: string;
  title?: string;
  scrollX?: number;
  scrollY?: number;
  tabs?: string[];
  viewport?: { width: number; height: number };
  dsr?: number;
  downloads?: DownloadRecord[];
  createdAt?: number;
  savedAt: number;
}

function readDurable(key: string): DurableState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(key), "utf8")) as DurableState;
  } catch {
    return null;
  }
}

/** checkpoint cookies/localStorage + navigation facts; never blocks callers */
async function saveDurable(inst: BrowserInstance): Promise<void> {
  if (!inst.context || inst.disposed) return;
  try {
    const storageState = await inst.context.storageState();
    let url: string | undefined;
    let title: string | undefined;
    let scrollX = 0;
    let scrollY = 0;
    let tabs: string[] = [];
    try {
      tabs = inst.context.pages().map((p) => p.url()).filter((u) => u && u !== "about:blank");
      if (inst.page && !inst.page.isClosed()) {
        url = inst.page.url();
        title = await inst.page.title().catch(() => undefined);
        const pos = (await inst.page.evaluate("({ x: window.scrollX, y: window.scrollY })").catch(() => null)) as { x: number; y: number } | null;
        if (pos) { scrollX = pos.x; scrollY = pos.y; }
      }
    } catch { /* navigation facts are best-effort */ }
    // re-check after the awaits above: if the instance was disposed meanwhile
    // (session deleted → durable file rm'd), this write must NOT resurrect it
    if (inst.disposed) return;
    const durable: DurableState = {
      key: inst.key, ownerAgentId: inst.ownerAgentId, label: inst.label,
      storageState, url, title, scrollX, scrollY, tabs,
      viewport: inst.viewport, dsr: inst.dsr, downloads: inst.downloads.slice(-50),
      createdAt: inst.createdAt, savedAt: Date.now(),
    };
    ensureDirs();
    fs.writeFileSync(stateFile(inst.key), JSON.stringify(durable), { mode: 0o600 });
    inst.lastSaved = Date.now();
  } catch { /* a dying context loses its last delta — recovery stays best-effort */ }
}

/* ---------------------------------------------------------------- lifecycle */

function dropLive(inst: BrowserInstance): void {
  inst.browser = null;
  inst.context = null;
  inst.page = null;
  inst.ariaRefWorks = true;
}

async function closeLive(inst: BrowserInstance): Promise<void> {
  const b = inst.browser;
  dropLive(inst);
  try { if (b) await b.close(); } catch { /* already gone */ }
}

/** tear an instance down for good: no queued or future call may relaunch it */
async function disposeInstance(inst: BrowserInstance): Promise<void> {
  inst.disposed = true;
  if (instances.get(inst.key) === inst) instances.delete(inst.key);
  await closeLive(inst);
}

async function launch(inst: BrowserInstance): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    // AutomationControlled off: headless Chromium otherwise advertises itself and
    // search engines/docs sites answer with bot challenges instead of content
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"],
    // Nexora owns process lifecycle: Playwright must NOT install its own signal
    // handlers, or a SIGTERM/SIGINT would kill Chromium and exit before the
    // graceful checkpoint in instrumentation.ts runs
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  inst.browser = browser;
  browser.on("disconnected", () => {
    // only react if THIS browser is still the instance's current one — a stale
    // listener from a replaced browser must never null out the live replacement
    if (inst.browser === browser) {
      dropLive(inst);
      inst.notes.push(CRASH_NOTE);
    }
  });
}

function downloadsDirFor(inst: BrowserInstance): string {
  const dir = path.join(DOWNLOADS_DIR, safeKey(inst.key));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function wirePage(inst: BrowserInstance, p: Page): void {
  inst.page = p; // popups/new tabs become the active page
  p.on("console", (msg) => pushConsole(inst, msg.type(), msg.text()));
  p.on("pageerror", (err) => pushConsole(inst, "error", String(err)));
  p.on("requestfailed", (req) => {
    const failure = req.failure();
    if (failure && failure.errorText !== "net::ERR_ABORTED") {
      pushConsole(inst, "network", `${req.method()} ${req.url()} — ${failure.errorText}`);
    }
  });
  p.on("dialog", (dialog) => {
    // a modal would otherwise wedge every later action until the watchdog
    // fires; accept it and tell the agent what it said
    pushConsole(inst, "dialog", `${dialog.type()}: ${dialog.message().slice(0, 300)}`);
    inst.notes.push(` (note: a ${dialog.type()} dialog said "${dialog.message().slice(0, 160)}" and was auto-accepted)`);
    void dialog.accept().catch(() => undefined);
  });
  p.on("download", (dl: Download) => {
    const rec: DownloadRecord = { file: "", path: "", url: dl.url(), suggestedFilename: dl.suggestedFilename(), bytes: 0, at: Date.now(), status: "saved" };
    inst.downloads.push(rec);
    void (async () => {
      try {
        const dir = downloadsDirFor(inst);
        const base = dl.suggestedFilename().replace(/[^\w.-]+/g, "_").slice(0, 80) || "download";
        rec.file = `${Date.now()}-${base}`;
        rec.path = path.join(dir, rec.file);
        await dl.saveAs(rec.path);
        rec.bytes = fs.statSync(rec.path).size;
        inst.notes.push(` (note: downloaded "${dl.suggestedFilename()}" → ${rec.path})`);
      } catch (err) {
        rec.status = "failed";
        rec.error = String((err as Error)?.message ?? err).slice(0, 200);
      }
    })();
  });
  p.on("close", () => {
    // adopt another open page so the next call is not a guaranteed relaunch
    if (inst.page === p && inst.context) {
      const open = inst.context.pages().filter((x) => !x.isClosed());
      inst.page = open.length ? open[open.length - 1] : null;
    }
  });
}

function pushConsole(inst: BrowserInstance, level: string, text: string): void {
  inst.consoleBuf.push({ level, text: String(text).slice(0, 500), at: Date.now() });
  if (inst.consoleBuf.length > 200) inst.consoleBuf.shift();
}

/** live page, creating browser+context lazily and restoring durable state */
async function ensurePage(inst: BrowserInstance): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (inst.disposed) throw new Error("This browser was released; a fresh one starts on the next tool call.");
      if (inst.browser && !inst.browser.isConnected()) {
        dropLive(inst);
        inst.notes.push(CRASH_NOTE);
      }
      if (inst.page && !inst.page.isClosed()) return inst.page;
      if (inst.context) {
        // active page closed but the context lives — adopt another open page
        const open = inst.context.pages().filter((p) => !p.isClosed());
        if (open.length > 0) { inst.page = open[open.length - 1]; return inst.page; }
      }
      if (!inst.browser) await launch(inst);
      if (!inst.context) {
        const durable = readDurable(inst.key);
        if (durable?.viewport) inst.viewport = durable.viewport;
        if (durable?.dsr) inst.dsr = durable.dsr;
        if (durable?.downloads && inst.downloads.length === 0) inst.downloads = durable.downloads;
        if (durable?.createdAt) inst.createdAt = durable.createdAt;
        inst.context = await inst.browser!.newContext({
          viewport: inst.viewport,
          deviceScaleFactor: inst.dsr,
          acceptDownloads: true,
          // the real Chromium version, minus the "HeadlessChrome" marker
          userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${inst.browser!.version()} Safari/537.36`,
          locale: "en-US",
          ...(durable?.storageState ? { storageState: durable.storageState as Parameters<Browser["newContext"]>[0] extends { storageState?: infer S } ? S : never } : {}),
        });
        inst.context.on("page", (p) => wirePage(inst, p));
        inst.page = await inst.context.newPage();
        if (durable?.url) {
          // best-effort recovery: reopen where the agent was, restore scroll.
          // Live-only state (JS heap, modals, sessionStorage) does not return.
          try {
            await inst.page.goto(durable.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
            if (durable.scrollX || durable.scrollY) {
              await inst.page.evaluate(`window.scrollTo(${durable.scrollX || 0}, ${durable.scrollY || 0})`).catch(() => undefined);
            }
            inst.notes.push(` (note: this browser was restored from saved state — cookies/localStorage recovered and ${durable.url} reopened; live in-page state such as sessionStorage, form contents, and open dialogs was reset)`);
          } catch {
            inst.notes.push(" (note: this browser was restored from saved state — cookies/localStorage recovered, but the previous page could not be reopened)");
          }
        } else if (durable?.storageState) {
          inst.notes.push(" (note: this browser was restored from saved state — cookies/localStorage recovered; there was no previous page to reopen)");
        }
        return inst.page;
      }
      inst.page = await inst.context.newPage();
      return inst.page;
    } catch (err) {
      if (inst.disposed) throw err;
      // a partially-launched browser (launch OK, context/page failed) must be
      // CLOSED, not merely forgotten, or its Chromium process is orphaned
      await closeLive(inst);
      if (attempt >= 1) throw err;
      inst.notes.push(CRASH_NOTE);
    }
  }
}

function takeNotes(inst: BrowserInstance): string {
  return inst.notes.splice(0).join("");
}

/* ---------------------------------------------------------------- snapshot */

function cap(s: unknown, max: number): string {
  const str = String(s ?? "");
  return str.length > max ? `${str.slice(0, max)}\n… [truncated — ${str.length - max} more chars]` : str;
}

async function snapshotText(inst: BrowserInstance): Promise<string> {
  // Accessible snapshot with [ref=eN] element ids. Tandem used Playwright's private
  // page._snapshotForAI(); newer Playwright exposes the same output as
  // locator.ariaSnapshot({ mode: "ai" }) — both resolve through the aria-ref selector.
  const page = inst.page as unknown as { _snapshotForAI?: () => Promise<unknown>; locator: Page["locator"] };
  const aria = async (): Promise<string> => {
    if (typeof page._snapshotForAI === "function") {
      const snap = await page._snapshotForAI();
      return typeof snap === "string" ? snap : String(snap);
    }
    const loc = page.locator("body") as unknown as { ariaSnapshot: (o?: { mode?: string }) => Promise<string> };
    return loc.ariaSnapshot({ mode: "ai" });
  };
  if (inst.ariaRefWorks) {
    // a navigation race ("execution context destroyed") is transient: retry once, then fall back for THIS call only.
    // Only a missing API disables the aria path for the instance.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await aria();
        if (text.trim() && /\[ref=(f\d+)?e\d+\]/.test(text)) return cap(text, 12_000);
        break;
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        console.warn(`[browser] aria snapshot attempt ${attempt + 1} failed for ${inst.key}: ${msg.split("\n")[0].slice(0, 160)}`);
        if (/is not a function|Unknown option|unexpected option|mode/i.test(msg)) { inst.ariaRefWorks = false; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  return cap(await customSnapshot(inst), 12_000);
}

// the in-page half of the fallback snapshot runs in the BROWSER — shipped as
// a source string so the server build needs no DOM typings
const CUSTOM_SNAPSHOT_JS = `(() => {
  let n = 0;
  const lines = [];
  const seen = new Set();
  document.querySelectorAll('[data-nexora-ref]').forEach((el) => el.removeAttribute('data-nexora-ref'));
  const labelText = (el) => {
    // accessible-name approximation: aria-label, <label for>, wrapping <label>, aria-labelledby, placeholder, alt, then own text/value
    const byFor = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const wrap = el.closest ? el.closest('label') : null;
    const byId = el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby')) : null;
    const cands = [el.getAttribute('aria-label'), byFor && byFor.innerText, wrap && wrap.innerText, byId && byId.innerText, el.getAttribute('placeholder'), el.getAttribute('alt'), el.getAttribute('title'), el.innerText, el.value];
    for (const c of cands) { const t = (c || '').trim().replace(/\\s+/g, ' '); if (t) return t.slice(0, 80); }
    return '';
  };
  const label = (el) => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') ? labelText(el) : ((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 80));
  const push = (el, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    n += 1;
    const ref = 't' + n;
    el.setAttribute('data-nexora-ref', ref);
    lines.push('- ' + kind + ' "' + label(el) + '" [ref=' + ref + ']');
  };
  document.querySelectorAll('button, [role=button], input[type=submit]').forEach((el) => push(el, 'button'));
  document.querySelectorAll('a[href]').forEach((el) => push(el, 'link'));
  document.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea').forEach((el) => push(el, 'input(' + (el.type || 'text') + ')'));
  document.querySelectorAll('select').forEach((el) => push(el, 'select'));
  document.querySelectorAll('[role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], summary').forEach((el) => push(el, el.getAttribute('role') || 'control'));
  const bodyText = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000);
  return 'Interactive elements:\\n' + (lines.slice(0, 150).join('\\n') || '(none found)') + '\\n\\nVisible text:\\n' + bodyText;
})()`;

async function customSnapshot(inst: BrowserInstance): Promise<string> {
  return (await inst.page!.evaluate(CUSTOM_SNAPSHOT_JS)) as string;
}

const PAGE_TEXT_JS = `(() => {
  const pick = document.querySelector('article, main, [role=main]') || document.body;
  return (pick ? pick.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
})()`;

type Args = Record<string, unknown>;

function locFor(inst: BrowserInstance, args: Args) {
  const page = inst.page!;
  if (args.ref) {
    const ref = String(args.ref).replace(/[^\w-]/g, "");
    // aria refs are e12, or f2e12 after navigations (frame generation prefix); t12 is the fallback snapshot
    if (/^(f\d+)?e\d+$/i.test(ref) && inst.ariaRefWorks) return page.locator(`aria-ref=${ref}`);
    return page.locator(`[data-nexora-ref="${ref}"]`);
  }
  if (args.selector) return page.locator(String(args.selector)).first();
  throw new Error('Provide "ref" (from browser_snapshot) or a CSS "selector".');
}

async function pageInfo(inst: BrowserInstance): Promise<{ url?: string; title?: string }> {
  try {
    return { url: inst.page!.url(), title: await inst.page!.title() };
  } catch {
    return { url: inst.page ? inst.page.url() : undefined, title: undefined };
  }
}

function tabsList(inst: BrowserInstance): { index: number; url: string; active: boolean }[] {
  if (!inst.context) return [];
  return inst.context.pages().filter((p) => !p.isClosed()).map((p, index) => ({ index, url: p.url(), active: p === inst.page }));
}

/** files an agent may upload: its workspace and the browser download folder */
function assertUploadable(inst: BrowserInstance, p: string): string {
  const abs = fs.realpathSync(path.resolve(p));
  const roots = [path.join(WORKSPACES_DIR, inst.ownerAgentId), DOWNLOADS_DIR].map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  if (!roots.some((r) => abs === r || abs.startsWith(r + path.sep))) throw new Error(`Refusing to upload ${p}: only files in your workspace or the download folder can be uploaded.`);
  return abs;
}

/* ---------------------------------------------------------------- tool handlers */

type Handler = (inst: BrowserInstance, args: Args) => Promise<BrowserToolResult>;

const handlers: Record<string, Handler> = {
  async browser_navigate(inst, args) {
    await ensurePage(inst);
    const page = inst.page!;
    const url = String(args.url || "").trim();
    let action = "navigate";
    if (url === "back") { await page.goBack({ timeout: 15_000 }); action = "back"; }
    else if (url === "forward") { await page.goForward({ timeout: 15_000 }); action = "forward"; }
    else if (url === "reload") { await page.reload({ timeout: 20_000 }); action = "reload"; }
    else {
      if (!/^(https?|file):\/\//i.test(url)) throw new Error("URL must start with http://, https://, or file://");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    const snap = await snapshotText(inst);
    return {
      report: { action, detail: `${action === "navigate" ? "Opened" : action} ${info.url}`, ...info },
      text: `Loaded: ${info.title || "(no title)"} — ${info.url}\n\n${snap}`,
    };
  },

  /* ---------------- owner handlers (Browser Dock) ----------------
     Not agent tools: they are reached only through the owner's dock API,
     and they drive the very same instance — the page the agent is on. */

  /** A frame for the dock plus what the owner needs to see around it. */
  async owner_view(inst) {
    await ensurePage(inst);
    const page = inst.page!;
    const buf = await page.screenshot({ type: "jpeg", quality: 62, scale: "css", timeout: 15_000 });
    const info = await pageInfo(inst);
    return {
      report: { action: "view", detail: "Owner viewed the browser", ...info },
      text: JSON.stringify({
        image: `data:image/jpeg;base64,${buf.toString("base64")}`,
        url: info.url ?? null,
        title: info.title ?? null,
        viewport: inst.viewport,
        tabs: tabsList(inst),
        canGoBack: true,
      }),
    };
  },

  /** Owner input, in CSS pixels of the screenshot above. */
  async owner_click(inst, args) {
    await ensurePage(inst);
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y are required");
    await inst.page!.mouse.click(x, y, { clickCount: args.double ? 2 : 1, delay: 20 });
    await inst.page!.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    return { report: { action: "click", detail: `Owner clicked (${Math.round(x)}, ${Math.round(y)})`, ...info }, text: "ok" };
  },

  async owner_type(inst, args) {
    await ensurePage(inst);
    const text = String(args.text ?? "");
    if (text) await inst.page!.keyboard.type(text, { delay: 12 });
    return { report: { action: "type", detail: "Owner typed", value: "•••", ...(await pageInfo(inst)) }, text: "ok" };
  },

  async owner_key(inst, args) {
    await ensurePage(inst);
    const key = String(args.key ?? "").slice(0, 40);
    if (!key) throw new Error("key is required");
    await inst.page!.keyboard.press(key);
    await inst.page!.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    return { report: { action: "key", detail: `Owner pressed ${key}`, ...(await pageInfo(inst)) }, text: "ok" };
  },

  async owner_scroll(inst, args) {
    await ensurePage(inst);
    await inst.page!.mouse.wheel(Number(args.dx) || 0, Number(args.dy) || 0);
    return { report: { action: "scroll", detail: "Owner scrolled", ...(await pageInfo(inst)) }, text: "ok" };
  },

  async browser_get_state(inst) {
    const live = !!(inst.page && !inst.page.isClosed());
    const durable = live ? null : readDurable(inst.key);
    const info = live ? await pageInfo(inst) : { url: durable?.url, title: durable?.title };
    const tabs = live ? tabsList(inst) : (durable?.tabs ?? []).map((u, index) => ({ index, url: u, active: index === 0 }));
    const state = {
      session: inst.key,
      status: live ? "live" : durable ? "saved (restores on next action)" : "not started",
      url: info.url ?? null,
      title: info.title ?? null,
      tabs,
      viewport: { ...inst.viewport, deviceScaleFactor: inst.dsr },
      downloads: inst.downloads.length,
      lastActivityAt: new Date(inst.lastUsed).toISOString(),
    };
    return { report: { action: "state", detail: `State: ${state.status}${info.url ? ` · ${info.url}` : ""}`, ...info }, text: JSON.stringify(state, null, 2) };
  },

  async browser_snapshot(inst) {
    await ensurePage(inst);
    const info = await pageInfo(inst);
    const snap = await snapshotText(inst);
    return {
      report: { action: "snapshot", detail: `Inspected page structure (${info.title || info.url})`, ...info },
      text: `${info.title || "(no title)"} — ${info.url}\n\n${snap}`,
    };
  },

  async browser_read(inst, args) {
    await ensurePage(inst);
    const max = Math.min(Math.max(Number(args.maxChars) || 12_000, 500), 60_000);
    let text: string;
    if (args.ref || args.selector) text = await locFor(inst, args).innerText({ timeout: 8_000 });
    else text = (await inst.page!.evaluate(PAGE_TEXT_JS)) as string;
    const info = await pageInfo(inst);
    return {
      report: { action: "read", detail: `Read page text (${Math.min(text.length, max)} chars) · ${info.title || info.url}`, ...info },
      text: `${info.title || "(no title)"} — ${info.url}\n\n${cap(text, max)}`,
    };
  },

  async browser_click(inst, args) {
    await ensurePage(inst);
    const loc = locFor(inst, args);
    const before = inst.context!.pages().length;
    if (args.doubleClick) await loc.dblclick({ timeout: 8_000 });
    else await loc.click({ timeout: 8_000 });
    await inst.page!.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    // a click that opened a popup/tab: the 'page' hook already made it active
    const opened = inst.context!.pages().length - before;
    const info = await pageInfo(inst);
    const what = String(args.element || args.ref || args.selector);
    return {
      report: { action: "click", detail: `Clicked ${what}${opened > 0 ? " (opened a new tab)" : ""}`, ref: String(args.ref || args.selector), ...info },
      text: `Clicked ${what}.${opened > 0 ? ` A new tab opened and is now active (${opened} new).` : ""} Now at: ${info.title || ""} — ${info.url}`,
    };
  },

  async browser_type(inst, args) {
    await ensurePage(inst);
    const loc = locFor(inst, args);
    let sensitive = !!args.sensitive;
    let text = args.text === undefined ? "" : String(args.text);
    if (args.credential) {
      // a stored credential is typed at execution time and never returned to the agent
      const db = readDb();
      const wanted = String(args.credential).trim().toLowerCase();
      const cred = db.credentials.find((c) => c.id === args.credential || c.name.toLowerCase() === wanted || (c.name.startsWith("payment:") && `payment:${db.paymentMethods.find((m) => m.credentialId === c.id)?.id ?? ""}`.toLowerCase() === wanted));
      if (!cred) throw new Error(`Credential "${args.credential}" not found.`);
      // payment-method secrets: only while this agent holds an active payment authorization for that method
      if (cred.hidden && !authorizationAllowsCredential(inst.ownerAgentId, cred.id)) throw new Error("No active payment authorization for this payment method: call begin_payment on an approved payment request first.");
      const values = credentialValues(cred.id);
      const key = args.key ? String(args.key) : Object.keys(values)[0];
      if (!key || values[key] === undefined) throw new Error(`Credential "${cred.name}" has no key ${args.key ?? "(none)"}; keys: ${Object.keys(values).join(", ")}`);
      text = values[key];
      sensitive = true;
    } else if (args.text === undefined) throw new Error('Provide "text" (or credential + key).');
    // anything that equals an authorized payment secret (card/account/routing/CVV) is redacted everywhere
    if (!sensitive && text && activePaymentSecretStrings().some((v) => text.replace(/[\s-]/g, "") === v || text === v)) sensitive = true;
    try {
      const type = await loc.evaluate((el: HTMLInputElement) => (el.type || "").toLowerCase()).catch(() => "");
      if (type === "password") sensitive = true;
    } catch { /* non-input */ }
    await loc.fill(text, { timeout: 8_000 });
    if (args.submit) await loc.press("Enter");
    const info = await pageInfo(inst);
    const what = String(args.element || args.ref || args.selector);
    const shown = sensitive ? "•••" : cap(text, 200);
    return {
      report: { action: "type", detail: `Typed into ${what}${args.submit ? " and pressed Enter" : ""}`, ref: String(args.ref || args.selector), value: shown, ...info },
      text: `Filled ${what} with ${sensitive ? "(redacted)" : JSON.stringify(shown)}${args.submit ? " and submitted" : ""}.`,
    };
  },

  async browser_select(inst, args) {
    await ensurePage(inst);
    const loc = locFor(inst, args);
    const values = ((args.values as unknown[]) || []).map(String);
    let chosen: string[];
    try { chosen = await loc.selectOption(values.map((v) => ({ label: v })), { timeout: 5_000 }); }
    catch { chosen = await loc.selectOption(values, { timeout: 5_000 }); }
    const info = await pageInfo(inst);
    return {
      report: { action: "select", detail: `Selected ${values.join(", ")}`, ref: String(args.ref || args.selector), value: values.join(", "), ...info },
      text: `Selected ${JSON.stringify(chosen)}.`,
    };
  },

  async browser_press(inst, args) {
    await ensurePage(inst);
    await inst.page!.keyboard.press(String(args.key));
    await inst.page!.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    return { report: { action: "press", detail: `Pressed ${args.key}`, ...info }, text: `Pressed ${args.key}.` };
  },

  async browser_scroll(inst, args) {
    await ensurePage(inst);
    if (args.ref || args.selector) {
      await locFor(inst, args).scrollIntoViewIfNeeded({ timeout: 5_000 });
      const info = await pageInfo(inst);
      return { report: { action: "scroll", detail: `Scrolled ${args.ref || args.selector} into view`, ...info }, text: "Scrolled element into view." };
    }
    const dy = Number(args.dy ?? 600);
    const dx = Number(args.dx ?? 0);
    await inst.page!.mouse.wheel(dx, dy);
    const info = await pageInfo(inst);
    return { report: { action: "scroll", detail: `Scrolled by ${dx},${dy}`, ...info }, text: `Scrolled by (${dx}, ${dy}).` };
  },

  async browser_wait(inst, args) {
    await ensurePage(inst);
    const page = inst.page!;
    if (args.text) {
      await page.getByText(String(args.text)).first().waitFor({ state: "visible", timeout: 30_000 });
      const info = await pageInfo(inst);
      return { report: { action: "wait", detail: `Waited until "${args.text}" appeared`, ...info }, text: `"${args.text}" is visible.` };
    }
    if (args.textGone) {
      await page.getByText(String(args.textGone)).first().waitFor({ state: "hidden", timeout: 30_000 });
      const info = await pageInfo(inst);
      return { report: { action: "wait", detail: `Waited until "${args.textGone}" disappeared`, ...info }, text: `"${args.textGone}" is gone.` };
    }
    if (args.selector) {
      await page.locator(String(args.selector)).first().waitFor({ state: "visible", timeout: 30_000 });
      const info = await pageInfo(inst);
      return { report: { action: "wait", detail: `Waited for ${args.selector}`, ...info }, text: `${args.selector} is visible.` };
    }
    if (args.urlContains) {
      const frag = String(args.urlContains);
      await page.waitForURL((u) => u.toString().includes(frag), { timeout: 30_000 });
      const info = await pageInfo(inst);
      return { report: { action: "wait", detail: `Waited until URL contained "${frag}"`, ...info }, text: `URL is now ${info.url}.` };
    }
    const s = Math.min(Math.max(Number(args.seconds) || 1, 0.1), 30);
    await new Promise((r) => setTimeout(r, s * 1000));
    const info = await pageInfo(inst);
    return { report: { action: "wait", detail: `Waited ${s}s`, ...info }, text: `Waited ${s}s.` };
  },

  async browser_screenshot(inst, args) {
    await ensurePage(inst);
    // `scale: 'css'` pins the capture to CSS pixels, so a deviceScaleFactor of
    // 2 or 3 no longer multiplies the image by 4x or 9x. A screenshot is read
    // once by the model but then re-read from cache on EVERY later request in
    // the session, so its size is paid hundreds of times over — a full-page
    // capture, which is unbounded in height, is compressed harder for that
    // reason. Visual verification does not need the extra bytes.
    const buf = await inst.page!.screenshot({
      type: "jpeg",
      quality: args.fullPage ? 55 : 70,
      scale: "css",
      fullPage: !!args.fullPage,
      timeout: 15_000,
    });
    const info = await pageInfo(inst);
    ensureDirs();
    const dir = path.join(SHOTS_DIR, safeKey(inst.key));
    fs.mkdirSync(dir, { recursive: true });
    inst.shotSeq += 1;
    const file = `${Date.now()}-${inst.shotSeq}.jpg`;
    fs.writeFileSync(path.join(dir, file), buf);
    return {
      report: {
        action: "screenshot",
        detail: `Screenshot${args.fullPage ? " (full page)" : ""} at ${inst.viewport.width}×${inst.viewport.height}`,
        screenshotFile: file,
        screenshotUrl: `/api/browser/shots/${safeKey(inst.key)}/${file}`,
        ...info,
      },
      content: [
        { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" },
        { type: "text", text: `Screenshot captured (${args.fullPage ? "full page" : `${inst.viewport.width}×${inst.viewport.height}`}) of ${info.url}` },
      ],
    };
  },

  async browser_resize(inst, args) {
    await ensurePage(inst);
    const width = Math.min(Math.max(Math.round(Number(args.width)), 200), 4000);
    const height = Math.min(Math.max(Math.round(Number(args.height)), 200), 4000);
    // capped at 2: screenshots are captured at CSS scale anyway, and a higher
    // factor only inflates what every later request re-reads
    const newDsr = args.deviceScaleFactor ? Math.min(Math.max(Number(args.deviceScaleFactor), 1), 2) : inst.dsr;
    inst.viewport = { width, height };
    let note = "";
    if (newDsr !== inst.dsr) {
      inst.dsr = newDsr;
      const current = inst.page!.url();
      // recreate the context WITH its storage — a scale change must not log out
      await saveDurable(inst);
      await inst.context!.close().catch(() => undefined);
      inst.context = null;
      inst.page = null;
      await ensurePage(inst);
      inst.notes.splice(0); // the restore note would be misleading here
      if (current && current !== "about:blank") {
        await inst.page!.goto(current, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
        note = ` (fresh context at deviceScaleFactor ${inst.dsr}; page reloaded, sign-in preserved)`;
      }
    } else {
      await inst.page!.setViewportSize(inst.viewport);
    }
    const info = await pageInfo(inst);
    return {
      report: { action: "resize", detail: `Viewport → ${width}×${height}${inst.dsr !== 1 ? ` @${inst.dsr}x` : ""}`, viewport: { ...inst.viewport, deviceScaleFactor: inst.dsr }, ...info },
      text: `Viewport is now ${width}×${height}${inst.dsr !== 1 ? ` at ${inst.dsr}x` : ""}${note}. The page is interactive at this size.`,
    };
  },

  async browser_tabs(inst, args) {
    await ensurePage(inst);
    const action = String(args.action ?? "list");
    const ctx = inst.context!;
    if (action === "new") {
      const p = await ctx.newPage(); // 'page' hook wires + activates it
      const url = args.url ? String(args.url) : "";
      if (url) {
        if (!/^(https?|file):\/\//i.test(url)) throw new Error("URL must start with http://, https://, or file://");
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      }
      inst.page = p;
    } else if (action === "switch") {
      const pages = ctx.pages().filter((p) => !p.isClosed());
      const i = Number(args.index);
      if (!Number.isInteger(i) || i < 0 || i >= pages.length) throw new Error(`No tab ${args.index}; open tabs: 0–${pages.length - 1}.`);
      inst.page = pages[i];
      await inst.page.bringToFront().catch(() => undefined);
    } else if (action === "close") {
      const pages = ctx.pages().filter((p) => !p.isClosed());
      const target = args.index === undefined ? inst.page! : pages[Number(args.index)];
      if (!target) throw new Error(`No tab ${args.index}.`);
      await target.close();
      const left = ctx.pages().filter((p) => !p.isClosed());
      inst.page = left.length ? left[left.length - 1] : null;
      if (!inst.page) await ensurePage(inst); // never leave the session without a page
    } else if (action !== "list") throw new Error("action must be list, switch, new or close");
    const tabs = tabsList(inst);
    const info = await pageInfo(inst);
    const listing = tabs.map((t) => `${t.active ? "▶" : " "} [${t.index}] ${t.url}`).join("\n") || "(no tabs)";
    return {
      report: { action: "tabs", detail: action === "list" ? `Listed ${tabs.length} tab${tabs.length === 1 ? "" : "s"}` : `Tab ${action}${args.index !== undefined ? ` ${args.index}` : ""} → ${tabs.length} open`, ...info },
      text: `${tabs.length} open tab${tabs.length === 1 ? "" : "s"} (▶ = active):\n${listing}`,
    };
  },

  async browser_downloads(inst, args) {
    const action = String(args.action ?? "list");
    if (action === "clear") inst.downloads = [];
    const list = inst.downloads;
    const info = inst.page && !inst.page.isClosed() ? await pageInfo(inst) : {};
    const text = list.length === 0
      ? "No downloads in this browser session."
      : list.map((d) => `${d.status === "saved" ? "✓" : "✗"} ${d.suggestedFilename} (${d.bytes} bytes) ← ${d.url}\n   ${d.status === "saved" ? d.path : `failed: ${d.error}`}`).join("\n");
    return { report: { action: "downloads", detail: action === "clear" ? "Cleared download list" : `Listed ${list.length} download${list.length === 1 ? "" : "s"}`, ...info }, text };
  },

  async browser_upload(inst, args) {
    await ensurePage(inst);
    const loc = locFor(inst, args);
    const paths = ((args.paths as unknown[]) || []).map(String).map((p) => assertUploadable(inst, p));
    if (paths.length === 0) throw new Error("paths is required.");
    await loc.setInputFiles(paths, { timeout: 8_000 });
    const info = await pageInfo(inst);
    const what = String(args.element || args.ref || args.selector);
    return {
      report: { action: "upload", detail: `Attached ${paths.length} file${paths.length === 1 ? "" : "s"} to ${what}`, ref: String(args.ref || args.selector), value: paths.map((p) => path.basename(p)).join(", "), ...info },
      text: `Attached ${paths.map((p) => path.basename(p)).join(", ")} to ${what}.`,
    };
  },

  async browser_console(inst, args) {
    await ensurePage(inst);
    const level = args.level === "all" ? "all" : "error";
    const entries = inst.consoleBuf.filter((e) => level === "all" || e.level === "error" || e.level === "network" || e.level === "warning" || e.level === "dialog");
    const shown = entries.slice(-40);
    const info = await pageInfo(inst);
    return {
      report: {
        action: "console",
        detail: `Read console (${shown.length} ${level === "all" ? "entries" : "errors/warnings"})`,
        console: shown.slice(-12).map(({ level: l, text }) => ({ level: l, text: cap(text, 200) })),
        ...info,
      },
      text: shown.length === 0
        ? `No ${level === "all" ? "console output" : "errors or warnings"} recorded on this page.`
        : shown.map((e) => `[${e.level}] ${e.text}`).join("\n"),
    };
  },

  async browser_evaluate(inst, args) {
    await ensurePage(inst);
    const value = await inst.page!.evaluate((code: string) => {
      const r = eval(code);
      try { return JSON.parse(JSON.stringify(r)); } catch { return String(r); }
    }, String(args.code));
    const info = await pageInfo(inst);
    const text = cap(typeof value === "string" ? value : JSON.stringify(value, null, 2), 5_000);
    return {
      report: { action: "evaluate", detail: `Evaluated: ${cap(String(args.code), 90)}`, ...info },
      text,
    };
  },

  async browser_search(inst, args) {
    await ensurePage(inst);
    const page = inst.page!;
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required.");
    const max = Math.min(Math.max(Number(args.maxResults) || 8, 1), 20);
    type Hit = { title: string; url: string; snippet: string };
    const decode = (u: string) => {
      try {
        const parsed = new URL(u, "https://www.bing.com");
        // Bing wraps targets as /ck/a?…&u=a1<base64url>
        const enc = parsed.hostname.endsWith("bing.com") && parsed.pathname.startsWith("/ck/") ? parsed.searchParams.get("u") : null;
        if (enc && enc.startsWith("a1")) return Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        // DuckDuckGo wraps targets as /l/?uddg=<encoded>
        const t = parsed.searchParams.get("uddg");
        return t ? decodeURIComponent(t) : parsed.toString();
      } catch { return u; }
    };
    // DuckDuckGo answers headless Chromium with a bot challenge, so the engines
    // that reliably serve HTML results come first; all are tried in order.
    const engines = [
      { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, js: `Array.from(document.querySelectorAll('#b_results > li.b_algo')).map((r) => { const a = r.querySelector('h2 a'); const s = r.querySelector('.b_caption p, p'); return a ? { title: a.innerText.trim(), url: a.getAttribute('href') || '', snippet: s ? s.innerText.trim() : '' } : null; }).filter(Boolean)` },
      { url: `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, js: `Array.from(document.querySelectorAll('#mixed-main .snippet')).map((box) => { const a = box.querySelector('.result-content a[href^="http"], a.l1'); if (!a) return null; const lines = a.innerText.split('\\n').map((l) => l.trim()).filter(Boolean); const title = lines[lines.length - 1] || ''; const desc = box.querySelector('.snippet-description, .snippet-content, .desc'); return { title, url: a.getAttribute('href') || '', snippet: desc ? desc.innerText.trim() : '' }; }).filter(Boolean)` },
      { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, js: `Array.from(document.querySelectorAll('.result')).map((r) => { const a = r.querySelector('a.result__a'); const s = r.querySelector('.result__snippet'); return a ? { title: a.innerText.trim(), url: a.getAttribute('href') || '', snippet: s ? s.innerText.trim() : '' } : null; }).filter(Boolean)` },
    ];
    let hits: Hit[] = [];
    let used = "";
    for (const engine of engines) {
      try {
        await page.goto(engine.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
        const raw = (await page.evaluate(engine.js)) as Hit[];
        hits = raw.map((h) => ({ ...h, url: decode(h.url) })).filter((h) => /^https?:\/\//.test(h.url)).slice(0, max);
        if (hits.length) { used = new URL(engine.url).hostname; break; }
      } catch { /* try the next engine */ }
    }
    const info = await pageInfo(inst);
    if (!hits.length) return { report: { action: "search", detail: `Searched "${query}" — no results`, ...info }, text: `No results for "${query}" (search engines may be blocking automated access; try browser_navigate on a site you know).`, isError: true };
    const text = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${cap(h.snippet, 280)}` : ""}`).join("\n");
    return { report: { action: "search", detail: `Searched "${cap(query, 80)}" — ${hits.length} results via ${used}`, ...info }, text: `Results for "${query}" (${used}):\n${text}` };
  },

  // ------------------------------------------------ lifecycle tools

  async browser_reload(inst, args) {
    // reload operates on the CURRENT page — it never lazily creates one
    if (!inst.page || inst.page.isClosed()) {
      throw new Error("No active page to reload — navigate somewhere first (browser_navigate).");
    }
    const hard = !!args.hard;
    if (hard) {
      // cache-bypassing reload: clear the HTTP cache via CDP, keep cookies/storage
      try {
        const cdp = await inst.context!.newCDPSession(inst.page);
        await cdp.send("Network.clearBrowserCache");
        await cdp.detach().catch(() => undefined);
      } catch { /* non-chromium or CDP hiccup — the plain reload below still runs */ }
    }
    await inst.page.reload({ timeout: 20_000, waitUntil: "domcontentloaded" });
    await inst.page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    return {
      report: { action: "reload", detail: `${hard ? "Hard-reloaded (cache cleared)" : "Reloaded"} ${info.url}`, ...info },
      text: `${hard ? "Hard-reloaded (HTTP cache cleared; cookies and sign-in preserved)" : "Reloaded"}: ${info.title || "(no title)"} — ${info.url}`,
    };
  },

  async browser_reset(inst) {
    // fresh live context for THIS session only; durable auth survives
    await saveDurable(inst);
    await closeLive(inst);
    await ensurePage(inst);
    const restored = takeNotes(inst);
    const info = await pageInfo(inst);
    return {
      report: { action: "reset", detail: `Browser reset — fresh context${restored ? ", saved state restored" : ""}`, ...info },
      text: `Browser reset: a fresh context replaced the previous one.${restored || " No saved state existed, so it starts blank."} Live-only state (open dialogs, sessionStorage, in-memory page state) is gone by design.`,
    };
  },

  async browser_kill(inst) {
    // release live resources; durable auth/storage is deliberately KEPT.
    // dispose so no queued call for this key relaunches a browser afterward.
    await saveDurable(inst);
    await disposeInstance(inst);
    return {
      report: { action: "kill", detail: "Browser closed — saved state kept for the next use" },
      text: "Browser closed and its resources released. Cookies/localStorage and the last page were saved: the next browser tool call starts a fresh browser and restores them. (This is not a logout — use the site's own logout, or clear state via browser_evaluate, if you need that.)",
    };
  },

  /** test hook (regression suite only): kill Chromium out from under the instance to exercise crash recovery */
  async _test_crash(inst) {
    if (process.env.NEXORA_BROWSER_TEST_HOOKS !== "1") throw new Error("Test hooks are disabled.");
    await ensurePage(inst);
    // kill the Chromium process out from under Playwright (the same signal a
    // real crash produces); fall back to an abrupt CDP Browser.close
    const proc = (inst.browser as unknown as { process?: () => { kill: (sig: string) => void } | null }).process?.();
    if (proc) proc.kill("SIGKILL");
    else {
      const cdp = await inst.context!.newCDPSession(inst.page!);
      await cdp.send("Browser.close").catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 800));
    return { report: { action: "crash", detail: "Chromium killed (test hook)" }, text: "Chromium was killed; the next call must recover." };
  },
};

/* ---------------------------------------------------------------- entry point */

/**
 * Execute one browser tool for a session. Calls on the same instance are
 * strictly serialized — overlapping invocations can never interleave CDP
 * operations on one context.
 */
export async function handleBrowserTool(scope: BrowserScope, name: string, args: Record<string, unknown>): Promise<BrowserToolResult> {
  const handler = handlers[name];
  if (!handler) return { text: `Unknown tool ${name}`, isError: true, report: null };
  const inst = getInstance(scope);
  const run = inst.chain.then(async (): Promise<BrowserToolResult> => {
    inst.lastUsed = Date.now();
    inst.inFlight += 1;
    try {
      // watchdog: a wedged handler must not block this instance's chain (which
      // includes the recovery tools) forever. On timeout the instance is
      // disposed, so the agent's next call gets a fresh, working browser.
      let timer: NodeJS.Timeout | undefined;
      const out = (await Promise.race([
        handler(inst, args ?? {}),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("the browser operation timed out and the browser was reset; retry your last step")), CALL_WATCHDOG_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); })) as BrowserToolResult;
      const note = takeNotes(inst);
      if (note && out.report) out.report = { ...out.report, detail: `${out.report.detail}${note.includes("crash") ? " · browser restarted after a crash" : note.includes("downloaded") ? " · file downloaded" : note.includes("dialog") ? " · dialog auto-accepted" : " · restored from saved state"}` };
      if (out.content) {
        const textPart = out.content.find((c): c is { type: "text"; text: string } => c.type === "text");
        if (note && textPart) textPart.text = `${textPart.text}${note}`;
      } else {
        out.text = `${out.text ?? "ok"}${note}`;
      }
      // periodic durable checkpoint so a hard crash loses little
      if (!inst.disposed && Date.now() - inst.lastSaved > CHECKPOINT_MS && instances.get(inst.key) === inst) void saveDurable(inst);
      return out;
    } catch (err) {
      const message = String((err as Error)?.message ?? err).split("\n")[0].slice(0, 400);
      // a watchdog trip means the live context is wedged — dispose it so the
      // next call self-heals rather than queueing behind the stuck operation
      if (/timed out and the browser was reset/.test(message)) { void disposeInstance(inst); }
      let info: Record<string, unknown> = {};
      try { if (!inst.disposed && inst.page) info = await pageInfo(inst); } catch { /* no page */ }
      return {
        text: `${name} failed: ${message}`,
        isError: true,
        report: { action: name.replace("browser_", ""), detail: `${name.replace("browser_", "")} failed`, error: message, status: "failed", ...info },
      };
    } finally {
      inst.inFlight -= 1;
    }
  });
  inst.chain = run.catch(() => undefined); // the chain itself never rejects
  return run;
}

/**
 * Cancel whatever this session is doing: the live browser is torn down so the
 * in-flight Playwright operation rejects immediately and queued calls get a
 * clean "released" error. Durable state is checkpointed first.
 */
export async function cancelBrowser(key: string): Promise<boolean> {
  const inst = instances.get(key);
  if (!inst) return false;
  await saveDurable(inst);
  await disposeInstance(inst);
  return true;
}

/** Release a session's live browser. Durable state optionally erased — deletion must leave no cookies behind. */
export async function releaseBrowser(key: string, opts: { deleteDurable: boolean }): Promise<void> {
  const inst = instances.get(key);
  if (inst) {
    if (!opts.deleteDurable) await saveDurable(inst);
    await disposeInstance(inst); // disposed → a mid-flight/queued call can't resurrect it
  }
  if (opts.deleteDurable) {
    // dispose (above) has set inst.disposed, so no checkpoint can rewrite the
    // file after this rm — the deletion is the last word
    try { fs.rmSync(stateFile(key), { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(path.join(SHOTS_DIR, safeKey(key)), { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(path.join(DOWNLOADS_DIR, safeKey(key)), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** graceful shutdown: checkpoint every instance, close every Chromium */
export async function shutdownBrowsers(): Promise<void> {
  const all = [...instances.values()];
  instances.clear();
  await Promise.allSettled(all.map(async (inst) => {
    inst.disposed = true;
    await saveDurable(inst);
    await closeLive(inst);
  }));
}

/** idle reaper: live Chromium is released after IDLE_MS; durable state stays */
let reaper: NodeJS.Timeout | null = null;
export function startBrowserReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const inst of instances.values()) {
      // idle means no call in the last 30 min, so nothing is in flight
      if (now - inst.lastUsed > IDLE_MS && inst.inFlight === 0) {
        void (async () => {
          await saveDurable(inst);
          await disposeInstance(inst);
        })();
      }
    }
  }, REAPER_TICK_MS);
  reaper.unref?.();
}

/** test/observability hook: which instances are live right now */
export function liveBrowserKeys(): string[] {
  return [...instances.keys()];
}

/** Every known session: live instances plus saved checkpoints. */
export function listBrowserSessions(): BrowserSessionInfo[] {
  const out = new Map<string, BrowserSessionInfo>();
  ensureDirs();
  for (const f of fs.readdirSync(BROWSER_STATE_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(BROWSER_STATE_DIR, f), "utf8")) as DurableState;
      if (!d.key) continue;
      out.set(d.key, {
        id: d.key, ownerAgentId: d.ownerAgentId ?? "", label: d.label ?? d.key, status: "saved",
        currentUrl: d.url, title: d.title, tabs: d.tabs?.length ?? 0, viewport: d.viewport ?? { width: 1280, height: 800 },
        downloads: d.downloads?.length ?? 0, createdAt: d.createdAt ?? d.savedAt, lastActivityAt: d.savedAt, busy: false,
      });
    } catch { /* unreadable checkpoint */ }
  }
  for (const inst of instances.values()) {
    const live = !!(inst.page && !inst.page.isClosed());
    out.set(inst.key, {
      id: inst.key, ownerAgentId: inst.ownerAgentId, label: inst.label, status: "live",
      currentUrl: live ? inst.page!.url() : undefined, title: undefined, tabs: live ? tabsList(inst).length : 0,
      viewport: inst.viewport, downloads: inst.downloads.length, createdAt: inst.createdAt, lastActivityAt: inst.lastUsed, busy: inst.inFlight > 0,
    });
  }
  return [...out.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Where a session's screenshots live (for the serving route). */
export function shotPath(sessionSafeKey: string, file: string): string | null {
  if (!/^[\w-]+$/.test(sessionSafeKey) || !/^[\w-]+\.jpg$/.test(file)) return null;
  const full = path.join(SHOTS_DIR, sessionSafeKey, file);
  return fs.existsSync(full) ? full : null;
}
