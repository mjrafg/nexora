/* ------------------------------------------------------------------
   Nexora Browser — tool contract.

   Ported/adapted from Tandem's mcp-browser.cjs tool list (names, parameters
   and semantics preserved so agents trained on that contract keep working),
   plus the additions Nexora needs: explicit state, page text, tabs,
   downloads, uploads and a runtime-independent web search.

   One source of truth: the stdio proxy (scripts/mcp-nexora.mjs) fetches this
   list from the app at start-up; the API runtime uses it in-process.
   ------------------------------------------------------------------ */

export type BrowserToolDef = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

const el = {
  ref: { type: "string", description: "Element ref from the latest snapshot (e.g. e12 or t3)." },
  selector: { type: "string", description: "CSS selector, when no ref is available." },
  element: { type: "string", description: "Short human description for the activity log." },
};

export const BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: "browser_navigate",
    description: "Open a URL in Nexora's internal Chromium browser (real rendering; localhost and file:// URLs work). Also accepts \"back\", \"forward\", or \"reload\". Returns the page title, URL, and an element snapshot with [ref=…] ids for interaction. The browser belongs to you and persists across turns: earlier sign-ins and the last open page are still there.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "URL to open, or back|forward|reload" } }, required: ["url"] },
  },
  {
    name: "browser_get_state",
    description: "Current browser state without touching the page: session id, active URL and title, open tabs, viewport, downloads so far, whether a page is open.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_snapshot",
    description: "Get the current page's structure: interactive elements with [ref=…] ids plus visible text. Refs are valid until the page changes or the next snapshot. Works on whatever page your browser is currently on — including one left open in an earlier turn.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_read",
    description: "Read the page's visible text (article/main content first, then the body) — for documentation, pricing pages and long articles. Optionally only the text inside a ref/selector. Capped at maxChars (default 12000).",
    inputSchema: { type: "object", properties: { ...el, maxChars: { type: "number" } } },
  },
  {
    name: "browser_click",
    description: "Click an element, identified by ref (from the latest snapshot) or CSS selector.",
    inputSchema: { type: "object", properties: { ...el, doubleClick: { type: "boolean" } } },
  },
  {
    name: "browser_type",
    description: "Fill an input/textarea (clears it first), identified by ref or CSS selector. Set submit=true to press Enter afterwards. Set sensitive=true for secrets so the value is redacted in the activity log. To use a stored credential without seeing it, pass credential=\"<credential name>\" and key=\"<KEY>\" instead of text.",
    inputSchema: {
      type: "object",
      properties: {
        ...el,
        text: { type: "string" },
        submit: { type: "boolean" },
        sensitive: { type: "boolean" },
        credential: { type: "string", description: "Name or id of a Nexora credential whose value should be typed (never revealed to you)." },
        key: { type: "string", description: "Which key of that credential to type." },
      },
    },
  },
  {
    name: "browser_select",
    description: "Choose option(s) in a <select>, by visible label or value.",
    inputSchema: { type: "object", properties: { ...el, values: { type: "array", items: { type: "string" } } }, required: ["values"] },
  },
  {
    name: "browser_press",
    description: "Press a keyboard key on the page (e.g. Enter, Escape, Tab, ArrowDown, Control+a).",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page by dx/dy pixels (default dy=600), or scroll a specific element (ref/selector) into view.",
    inputSchema: { type: "object", properties: { dy: { type: "number" }, dx: { type: "number" }, ...el } },
  },
  {
    name: "browser_wait",
    description: "Wait for seconds (max 30), until text appears/disappears on the page, until a selector is visible, or until the URL contains a fragment.",
    inputSchema: { type: "object", properties: { seconds: { type: "number" }, text: { type: "string" }, textGone: { type: "string" }, selector: { type: "string" }, urlContains: { type: "string" } } },
  },
  {
    name: "browser_screenshot",
    description: "Capture a screenshot of the current page. You receive the image for visual inspection, and it is stored in the activity timeline for the owner — you never need to save it yourself. fullPage captures beyond the viewport.",
    inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } } },
  },
  {
    name: "browser_resize",
    description: "Set the viewport to any width×height (and optionally deviceScaleFactor). Changing deviceScaleFactor reloads the page in a fresh context (sign-in is preserved).",
    inputSchema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" }, deviceScaleFactor: { type: "number" } }, required: ["width", "height"] },
  },
  {
    name: "browser_tabs",
    description: "Manage tabs: action=list (default) shows open tabs with the active one marked; switch (index) activates a tab; new (optional url) opens a tab; close (index, default active) closes one. Popups opened by the page become tabs automatically.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "switch", "new", "close"] }, index: { type: "number" }, url: { type: "string" } } },
  },
  {
    name: "browser_downloads",
    description: "List files the browser downloaded in this session (saved under Nexora's download folder), with their local paths — use them with the filesystem tools. action=clear forgets the list.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "clear"] } } },
  },
  {
    name: "browser_upload",
    description: "Attach local file(s) to a file input (ref/selector). Only files inside your workspace or the browser download folder can be uploaded.",
    inputSchema: { type: "object", properties: { ...el, paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
  },
  {
    name: "browser_console",
    description: "Read recent browser console output, page errors, and failed network requests. level=\"error\" (default) filters to errors; level=\"all\" includes logs/warnings.",
    inputSchema: { type: "object", properties: { level: { type: "string", enum: ["error", "all"] } } },
  },
  {
    name: "browser_evaluate",
    description: "Run a JavaScript expression in the page and get its JSON result — for inspecting application state exposed through the rendered page.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "browser_search",
    description: "Web search through the browser (works on every runtime). Returns the top results as title, URL and snippet; open one with browser_navigate.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"] },
  },
  {
    name: "browser_reload",
    description: "Reload the current page in place. hard=true additionally clears the HTTP cache first (cookies and sign-in are always preserved). Errors if no page is open yet.",
    inputSchema: { type: "object", properties: { hard: { type: "boolean" } } },
  },
  {
    name: "browser_reset",
    description: "Replace your live browser context with a fresh one when it is stuck or contaminated. Cookies/localStorage are saved first and restored into the fresh context, and the previous page is reopened — but live-only state (open dialogs, sessionStorage, in-memory page state) is discarded.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_kill",
    description: "Close your browser and release its resources when you are done with it for a while. Cookies/localStorage and the last page are saved: the next browser tool call starts fresh and restores them. This is NOT a logout and does NOT clear browser data.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "present_browser",
    description:
      "Show the owner what is in YOUR browser right now, and optionally hand them the controls. Use it whenever a step needs a human in the page: a CAPTCHA or human check, a login or one-time code you cannot complete, a passkey prompt, an unexpected page, a choice only the owner can make, or something you want them to look at.\n" +
      "mode \"view\": the Browser Dock opens where they are watching and you keep working. Call it again with mode \"done\" once the thing you wanted seen has passed, so their dock does not sit open on nothing.\n" +
      "mode \"interactive\": the owner takes control of this same browser session (same tabs, cookies and page). STOP touching the browser and END YOUR TURN — you are resumed automatically when they hand control back, and you should then call browser_snapshot to see what changed.\n" +
      "This is not a capability or credential request: nothing is missing from Nexora, you just need the human in the page. Say precisely what you need in `reason` — it is the only thing the owner sees.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["view", "interactive", "done"], description: "view = they watch, you keep control; interactive = they drive; done = close the view you opened, when there is nothing left to look at" },
        reason: { type: "string", description: "what the owner should look at or do, e.g. \"Solve the CAPTCHA on the Google signup form, then return control\"" },
      },
      required: ["reason"],
    },
  },
];

export const BROWSER_TOOL_NAMES = BROWSER_TOOLS.map((t) => t.name);
