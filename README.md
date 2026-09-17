# Nexora OS — UI concept

A high-fidelity, frontend-only concept for an AI-native company operating system: a
dashboard where every department is run by AI agents and the human founder approves
what matters.

The dashboard is still driven by static mock data (`src/lib/mock-data.ts`), but the
**agent foundation is real**: agents are persisted, each agent has its own AI runtime
configuration (Runtime → Provider → Model), and private chat executes through that
runtime. See [AI runtime layer](#ai-runtime-layer) below.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000. The route `/scene` renders the office scene alone at
full width, which is handy when iterating on it.

## Stack

- Next.js 16 (App Router) · React 19 · TypeScript
- Tailwind CSS v4 (design tokens live in `src/app/globals.css` under `@theme`)
- Framer Motion for idle animations, walking agents, and panel transitions
- lucide-react icons

## Structure

```
src/
  app/
    page.tsx                 dashboard homepage (composition only)
    scene/page.tsx           dev route: office scene full-bleed
    globals.css              tokens, glass utilities, department colors
  lib/
    mock-data.ts             departments, agents, approvals, meeting, projects, KPIs
    iso.ts                   2:1 isometric projection helpers + seeded PRNG
    runtime/                 runtime abstraction + adapters (see below)
    mcp/                     MCP engine: credentials, servers, client, discovery, execution
    projects/                Project Director engine (plan → build → review → integrate → deliver)
    store/db.ts              file-backed persistence
  components/
    layout/                  Sidebar, TopBar
    ui/                      Panel, Badge, Button, AgentAvatar/AvatarStack, Sparkline
    office/
      OfficeScene.tsx        room layout, depth-sorted sprites, labels, hover/select
      primitives.tsx         IsoBox, WallPlane, GlassWall, Desk, Plant, AgentFigure, Walker
      screens.tsx            wall-screen content (code, kanban, chart, funnel, tickets…)
    widgets/                 Approvals, CurrentMeeting, ActivityFeed, AgentsPanel,
                             KpiStrip, ProjectsPanel, AgentPerformance, RevenueSnapshot,
                             DepartmentStrip, DateChip
```

## AI runtime layer

Every agent is independent from the engine that runs it:

```
Agent → RuntimeConfig → RuntimeType → ProviderConnection → Model
```

| Runtime      | Providers                          | How it executes                                                     |
| ------------ | ---------------------------------- | ------------------------------------------------------------------- |
| Claude Code  | Anthropic                          | `claude -p` (JSON output, per-agent session, tools mapped from permissions) |
| Codex        | OpenAI                             | `codex exec --json` (ephemeral run, prompt carries instructions + history)  |
| API          | Anthropic, OpenAI, OpenRouter, Custom | Anthropic Messages API via `@anthropic-ai/sdk`, or any OpenAI-compatible `/chat/completions` |

Default for a newly hired agent: **Claude Code · Anthropic · Claude Haiku 4.5**. Changing
runtime/provider/model edits the agent's `RuntimeConfig` in place, so id, department,
instructions, skills, tool permissions and conversation history are untouched.

### Where things live

```
src/lib/runtime/
  types.ts          Agent, RuntimeConfig, ProviderConnection, AgentRuntime contract
  catalog.ts        runtimes, providers, known models, tool catalog (add models here)
  index.ts          registry, resolution, system prompt, sendAgentMessage, testRuntimeConfig
  adapters/         claude-code.ts · codex.ts · api.ts · cli.ts (spawn helpers)
src/lib/store/db.ts file-backed store: data/nexora.json (+ data/secrets.json, 0600)
src/app/api/        agents, agents/[id]/{messages,test}, providers, providers/[id]/test,
                    runtime/test, catalog
src/app/agents/     list · hire · [id] profile with runtime card + chat
src/app/settings/providers   provider connection registry
```

### Credentials

Connections authenticate via an environment variable (default: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`), a key stored locally in `data/secrets.json`,
or "none" (the CLI runtime's own login). Secrets are referenced by id and never copied
into agents, prompts or API responses. `data/` is gitignored.

Claude Code and Codex use their own logins when the connection has no key, so the
default Anthropic connection works out of the box on a machine with Claude Code signed in.
The Codex adapter looks for `codex` on `PATH`, `CODEX_BIN`, or the binary bundled with the
ChatGPT desktop app, and reads the models that install can actually use from
`~/.codex/models_cache.json` (ChatGPT-account Codex rejects model ids outside that list).

### Runtime logins from the browser

Settings → AI Providers → **Runtime logins** signs the server's CLIs in without SSH
(`src/lib/runtime/logins.ts`, `/api/runtime-logins/*`):

- **Claude Code** runs the OAuth (PKCE) flow natively (no CLI puppeteering): it builds the
  same authorize URL the `claude` CLI uses, you sign in and paste the code, and it exchanges
  it at `api.anthropic.com/v1/oauth/token` for a long-lived token, stored as a secret and
  passed to `claude` as `CLAUDE_CODE_OAUTH_TOKEN` (an API key on the connection wins).
- **Codex** runs `codex login --device-auth`, shows the URL and one-time code, and waits
  until you finish in the browser; Codex stores the session in `~/.codex/auth.json`.

Both cards show the current login (`claude auth status`, `codex login status`) and can sign out.

### Testing a runtime

`POST /api/runtime/test` (or the **Test connection** button in Hire / Change) sends a tiny
probe through the exact Runtime + Provider + Model combination and reports
`✓ Connected` or the provider's error.

## Authentication

Single local user for now. Credentials live in `data/auth.json` (scrypt hash + session
secret, mode 0600), created or replaced with:

```bash
npm run auth:set -- <username> <password>
```

`src/proxy.ts` protects every page and API route: unauthenticated pages redirect to
`/login`, API calls get a 401. Login sets an HttpOnly, SameSite=Lax, signed session cookie
(7 days). The top-right user chip signs out. Login attempts are rate-limited per IP.

The test scripts in `scripts/` sign in as that user, so they need the password in the
environment — it is deliberately not in source control:

```bash
export NEXORA_PASS=<the owner password>      # NEXORA_USER defaults to "mjrafg"
node scripts/test-skills.mjs                 # …or any other scripts/test-*.mjs
```

A script run without `NEXORA_PASS` stops immediately and says so.

## Projects — the Director engine (ported from Tandem)

An independent port/adaptation of Tandem's Project Director: the Engineering department
runs real software projects end to end. Tandem is never modified or depended on.

```
Owner goal ──► Director agent (plans milestones) ──► independent plan review (≤3 rounds)
                     │ decomposes a milestone just in time into sessions
                     ▼
        Builder agent per session (own git worktree + branch)  ──►  Reviewer (read-only, fresh session)
                     ▲                       PASS │ FINDINGS ──► repair ──► round 2 ──► final repair (never re-reviewed)
                     └── checkpoint commit ◄──────┘
        integrate_milestone (merge session branches) ► complete_milestone ► project_deliver (ff base) ► complete_project
```

- **Where:** `src/lib/projects/` — `director.ts` (serialized Director turns, the eleven director
  tools, plan/recovery review loops, pause/resume, delivery), `session.ts` (launch, Builder turn,
  review loop, checkpoint, classification), `review.ts` (subject, reviewer prompt, verdict parser),
  `git.ts` (integration branch, worktrees, dependency merges, fast-forward delivery), `store.ts`
  (DAG validation, invariants, snapshots), `prompts.ts`. The Director's tools are served to CLI
  runtimes by `scripts/mcp-director.mjs` (stdio MCP → `/api/internal/director`, token-authenticated)
  and to the API runtime as in-app tools — the same engine either way.
- **Agents, not runtimes:** the Director, default Builder and Reviewer are ordinary agents. Builders
  must run on Claude Code or Codex (file + shell tools); the Reviewer runs read-only in a fresh
  session and judges against the session's *original* request (ported ledger semantics:
  `reviewsConsumed`, `lastVerdict`, `finalRepairDone` live on the session).
- **Invariants enforced by the engine, not prompts:** milestone/session dependency DAGs (no cycles,
  no starting before predecessors complete), one session at a time in a shared directory,
  unmerged branches block `complete_milestone`, undelivered work blocks `complete_project`,
  paused/terminal projects refuse every mutating tool.
- **UI:** `/projects` (list, New project), `/projects/[id]` (Project Chat with the Director, plan &
  sessions drawer with verdicts and findings, activity log, live tool feed via SSE
  `GET /api/projects/[id]/activity`). Pause/Resume from the header.
- **Boot:** `src/instrumentation.ts` marks sessions that were running when the process died as
  paused (`stopReason: restart`) so the Director can decide what to resume.

## Live activity

Chat shows what an agent is doing as it happens — each tool call, shell command, and file
edit appears with a running spinner and flips to done/failed, like Tandem's timeline.

- **Bus + stream:** `src/lib/activity.ts` (in-memory per-agent event bus) and the SSE route
  `GET /api/agents/[id]/activity`. The chat page subscribes with `EventSource`.
- **Sources:** the API runtime emits an event around each MCP tool call; Claude Code runs with
  `--output-format stream-json` and Codex with `--json`, and their tool/command/file events are
  parsed live. Every event is persisted onto the assistant message so history keeps the timeline.
- Inputs and outputs are the already-scrubbed values; secrets never appear.

## MCP engine (tools for agents)

An independent port/adaptation of Tandem's mature MCP implementation (Tandem is never
modified or depended on). Company-level MCP servers + reusable credentials; agents get
access through grants that live on the agent, independent of the AI runtime.

```
Credential (secret values, encrypted)      Company MCP Server (stdio | http)
        \________________  ________________/
                          \/
                    Agent MCP Grant  (all tools | selected tools)
                          |
        Claude Code / Codex / API  ── runs the agent's allowed tools
```

- **Where:** `src/lib/mcp/` — `types.ts`, `store.ts` (AES-256-GCM credential encryption,
  key at `data/mcp-secret.key`), `client.ts` (JSON-RPC over stdio + Streamable HTTP, pooled),
  `service.ts` (test, discover, resolve grants, execute with secret scrubbing),
  `views.ts` (secret-free views). Routes: `/api/credentials*`, `/api/mcp-servers*`
  (`/test`, `/refresh-tools`). UI: Settings → Tools & MCP, and the agent profile's MCP Access panel.
- **Credentials** hold one or more secret KEY=value pairs, encrypted at rest, masked in the UI,
  never returned by any API. Injected at execution time only: stdio → env vars; http → `${KEY}`
  substitution in headers. Secrets are scrubbed from every tool result and error.
- **Runtime integration:** for the API runtime the app runs the tool-use loop itself
  (Anthropic + OpenAI-compatible) and shows a per-call indicator in chat; for Claude Code and
  Codex it hands the agent's allowed servers to the CLI via a temporary MCP config (secrets in
  a 0600 file, not argv). Grants are unchanged when the runtime switches.
- **OAuth-protected servers (MCP Authorization spec):** HTTP servers that answer `401` with a
  `WWW-Authenticate: Bearer` (e.g. Zoho, Cloudflare's OAuth mode) are connected with OAuth 2.1 —
  metadata discovery, dynamic client registration, authorization-code + PKCE in the browser, and
  refresh (`src/lib/mcp/oauth.ts`, routes `/api/mcp-servers/[id]/oauth/*` and `/api/mcp-servers/oauth/callback`).
  Click **Authorize (OAuth)** on the server card. Tokens are stored encrypted and injected as a
  Bearer header at execution time. A token embedded in the server URL is only a resource id, not auth.
- **Failure isolation:** a broken server fails only its own test/among its own tools; other
  servers, agents, and chats keep working.

## Web Browser capability (ported from Tandem)

Nexora owns a real headless Chromium, adapted from Tandem's `engine/browserHost.ts` (Tandem itself is untouched). The server owns every browser, keyed by a session (`agent:<agentId>` by default, `lab:<name>` in the Test Lab), so a page an agent opened last turn is still there next turn — on any runtime.

- `src/lib/browser/host.ts` — the engine. Preserved Tandem behaviour: strict per-session serialization, 100 s call watchdog that disposes a wedged instance, durable checkpoints (cookies/localStorage/last URL/scroll/tabs) under `data/browser/`, lazy relaunch + restore after kill/idle reap/crash/restart with an honest note, crash detection via `disconnected`, partially launched browsers closed rather than orphaned, idle reaper (30 min), graceful checkpoint on SIGTERM (`src/lib/boot.ts`), screenshots at CSS scale as JPEG. Additions: dialog auto-accept, downloads (`data/downloads/<session>/`), tabs/popups, uploads restricted to the agent workspace + downloads, `browser_get_state`, `browser_read`, `browser_search` (Bing/Brave/DuckDuckGo through the browser, so search works on every runtime), a realistic user agent (headless Chromium otherwise gets bot challenges).
- `src/lib/browser/tools.ts` — the tool contract (Tandem's names kept: `browser_navigate/snapshot/click/type/select/press/scroll/wait/screenshot/resize/console/evaluate/reload/reset/kill` + `get_state/read/tabs/downloads/upload/search`). `browser_type` accepts `credential` + `key` to type a vault secret without revealing it.
- Access is the agent-level permission **Web browser** (`toolPermissions: browser`) — independent of Claude Code / Codex / API. CLI runtimes get it as the stdio MCP server `browser` (generic proxy `scripts/mcp-nexora.mjs` with a per-turn token → `POST /api/internal/tools`); the API runtime executes it in-process and receives screenshots as image blocks.
- Every action is recorded on the agent's activity stream (`kind: "browser"` with sanitized facts: URL, viewport, redacted value, console, screenshot URL) and rendered Tandem-style in the chat timeline; screenshots are served by `/api/browser/shots/<session>/<file>`.
- **Browser Test Lab** (Settings → Browser Lab): run any operation against a lab session, see the text the agent sees plus the screenshot, list/release/delete sessions, cancel an in-flight call. Regression suite: `node scripts/test-browser.mjs <baseUrl>` (23 checks: navigation, search, forms, select, keyboard, SPA, tabs/popups, dialogs, downloads, slow page, timeout, waits, durable reuse, live reuse, reset, serialization, cancellation, crash recovery with `NEXORA_BROWSER_TEST_HOOKS=1`, upload guard, delete).

## Capability Manager

A real Nexora agent (`capability-manager`, System Operations) with special tools, created automatically. Any agent that lacks a tool calls `request_capability` (Nexora tool available to every agent) instead of asking the owner.

```
agent → request_capability → request PENDING, agent shows "Waiting for capability"
  → Capability Manager turn(s): check existing → reuse creatively → research (browser) → install free MCP → test → grant minimum tools
  → RESOLVED / FAILED → the requester is resumed automatically (system message in its own conversation, same runtime session)
  → real spending → WAITING_FOR_PAYMENT → owner approves/rejects/discusses on the Capabilities page
```

- `src/lib/capabilities/` — `types.ts` (states: PENDING, RESEARCHING, INSTALLING, TESTING, RESOLVED, WAITING_FOR_PAYMENT, FAILED), `registry.ts` (one computed registry: native capabilities + known categories matched against MCP servers + every other server + records the manager registered), `store.ts` (requests, activity log, explicit capabilities), `prompts.ts` (playbook: resolution order, free-first, payment gate, "do not ask the owner"), `tools.ts` (console: list/add/edit/test/remove MCP servers, refresh tools, credentials, grants, register_capability, request status, resolve/fail, request_payment_approval), `manager.ts` (serialized loop, ≤6 turns per request, payment decisions, auto-resume, boot recovery).
- The manager reasons; Nexora's tools are the deterministic actions. Nothing service-specific is hardcoded. Secrets go to the vault via `create_credential` and are never echoed.
- UI: **Capabilities** page (registry + manager overview/requests/activity/chat, payment approval cards, "file a request" for testing); agent pages show a waiting badge and the Nexora resume message.
- API: `GET /api/capabilities`, `GET/POST /api/capability-requests`, `GET /api/capability-requests/:id`, `POST …/:id/decide` (`approved|rejected`), `POST …/:id/discuss`, SSE `/api/capabilities/activity`.

## Side-effect execution guard

Every tool an agent calls — MCP, Nexora internal, on Claude Code, Codex or the API runtime — goes through one path, the Nexora Tool Runner (`src/lib/tools/runner.ts`), and its Side-Effect Guard (`src/lib/guard/`). On CLI runtimes the CLI no longer talks to third-party MCP servers directly: each granted server is exposed through the per-turn-token proxy, so the guard sees `sendEmail` exactly like it sees a browser or console call.

- **Classification** (`guard/classify.ts`): `READ_ONLY` / `SIDE_EFFECT` / `FINANCIAL` from an explicit override (`db.toolPolicies`), MCP tool annotations (`readOnlyHint`, `destructiveHint`, persisted at discovery), then name/description heuristics. Internal tools declare `sideEffect` on their definition; browser actions stay unguarded by design.
- **Ledger** (`guard/ledger.ts`, `data/actions.json`): one row per side-effecting execution — scope, epoch, agent, tool identity, fingerprint (`sha256(scope + tool + canonical args)`), idempotency key, status `PENDING → SUCCEEDED | FAILED | UNCERTAIN`, sanitized args/result summary and an external reference (message id, record id…). `claim()` is synchronous from lookup to persisted insert, which on Node's single thread is the `UNIQUE(scope, fingerprint)` guarantee. 30-day retention, 5 000-row cap, PENDING rows never dropped; leftover PENDING rows become UNCERTAIN at boot.
- **Behaviour**: first call executes; an identical call in the same scope returns `{ status: "already_completed", deduplicated: true, executionId, originalResult }`; a concurrent identical call awaits the winner; a FAILED (confirmed, nothing done) row allows a retry; an UNCERTAIN row (timeout, reset, process exit) is never repeated — the agent is told to verify with read tools and, only if the action truly did not happen, call `start_new_action_attempt({ reason })` (audited epoch bump). When a tool schema declares `idempotencyKey`/`idempotency_key`/`clientRequestId`, Nexora's key is forwarded.
- **Scopes**: an owner message starts a new `executionScopeId` on the conversation; Nexora's own system messages continue it. A capability request records the requester's scope and the auto-resume runs in that same scope, so what completed before the wait cannot repeat after it. Manager turns use `caprequest:<id>`, project sessions `session:<id>`.
- **Audit**: `GET /api/actions[?scopeId=&agentId=]`; activity rows show "Already completed — duplicate prevented" / "Outcome uncertain — not repeated" with original time, agent and execution id. Owner harness: `POST /api/tools/run { agentId, tool, args, scopeId }` runs a tool as an agent through the same path.
- **Tests**: `node scripts/test-guard.mjs <baseUrl>` (mock provider `scripts/mock-sideeffect-mcp.mjs` counts real invocations): duplicate, concurrent, different scope, different args, confirmed failure, uncertain outcome, financial, read-only, provider idempotency, intentional repeat, persistence, no secrets.

## Payments MVP + Payment Method Registry

Owner-controlled company payments for agents: cards and US bank accounts in the vault, a deterministic automatic spending limit, owner approvals, short-lived execution authorizations, browser checkout by the agent, and a full history. **Temporary storage model:** raw card/bank details are encrypted in the Credential Vault (hidden from the MCP credential list, CVV under its own key). Replace with tokenized / virtual-card infrastructure before broader production use.

**The agent never receives card or bank numbers.** Every payment method carries a *usage description* ("Use this low-limit card for one-time purchases. Do not use it for subscriptions."). The agent reasons from `list_payment_methods()` (safe metadata + descriptions) to choose the method, identifies the checkout inputs in a browser snapshot, and calls `insert_payment_method_fields` mapping logical fields (`card_number`, `expiration`, `cvv`, `routing_number`, …) to element refs; Nexora reads the vault and types the values into the agent's own browser session. AI decides WHERE, Nexora supplies WHAT. Payment methods and login credentials are two separate registries (data, tools, permissions, approval rules); only the element-reference insertion pattern is shared.

- `src/lib/payments/` — `types.ts` (`PaymentMethod` with `description`, `status`, `createdBy`, usage counters; `PaymentAuthorization.paymentMethodId` is `null` when the agent may choose), `store.ts` (methods + vault, `assertDescription` ≥ 20 chars, `updateMethod` with secret rotation, `methodView` — the only shape agents see, settings, requests, authorizations, transactions, `redactPaymentSecrets`), `service.ts` (the rules: `amount <= autoApproveLimit → AUTO_APPROVED` else `WAITING_FOR_APPROVAL`; approve — optionally pinned to one method — / reject / cancel; `insertPaymentMethodFields` verifies request ownership, status, live authorization and method availability, then types via the browser host with `sensitive: true`; `beginPayment` is optional and returns non-secret checkout details only; `completePayment` validates `actual_amount <= authorized` or raises an owner-visible exception; transactions snapshot the method so history survives deletion), `tools.ts` (permission groups below).
- Permissions (existing grant model, `TOOL_CATALOG`): **Payments: request** (`payments`: `request_payment`, `get_payment_request`, `list_my_payment_requests`, `begin_payment`, `complete_payment`), **Payments: use** (`payments_use`: `list_payment_methods`, `get_payment_method`, `insert_payment_method_fields`, `insert_payment_method_field`), **Payments: create & update** (`payments_manage`: `save_payment_method`, `update_payment_method`). Deletion is owner-only. The Capability Manager has all three. Agents with `payments_use` get a mandatory prompt rule (`PAYMENT_RULE` in `src/lib/runtime/index.ts`): choose by description, never read inserted values back, request payment before any fee.
- Authorization gate: insertion is DENIED without the agent's own AUTO_APPROVED/APPROVED request and a live 30-minute authorization; if the owner approved with a specific method, only that method is accepted; disabled methods are refused. The first successful insertion marks the request PROCESSING and records the chosen method (snapshot) for history.
- Guard: insertion tools are deliberately not side effects (re-filling a cleared form is legitimate); `begin_payment` stays FINANCIAL, `complete_payment` / `request_payment` / `save_payment_method` / `update_payment_method` are SIDE_EFFECT. Secret-looking argument keys (`card_number`, `account_number`, `routing_number`, `cvv`, …) are masked in activity, the ledger and transcripts (`maskSecretArgs` in `src/lib/guard`).
- Above-limit requests made by the Capability Manager inside a capability request put that request into WAITING_FOR_PAYMENT; the owner's decision wakes the manager automatically. Other agents are resumed with a system message in the scope that made the request.
- UI: **Payments** → Overview, Payment Methods (cards with usage description, status, default, agent-created marker, usage; detail dialog; add card / bank dialog with usage description; edit dialog with description, status, address and secret rotation), Requests (approval cards: "let the agent choose by usage description" or pin one method; exception review), History (grouped, masked methods, transaction detail), Settings (automatic limit, default hint, currency). Live via SSE `/api/payments/events`.
- API: `/api/payments/{settings,methods,methods/:id,requests,requests/:id,requests/:id/(approve|reject|cancel|resolve),history,overview,events}`.
- Tests: `node scripts/test-payment-methods.mjs <baseUrl>` (spec §31–§41: list/safe metadata, permissions, denial without authorization, card checkout, ACH checkout with a `<select>` account type, owner-pinned method, retryable insertion, save/update/rotation/disable by a manager agent, paid method creation with approval + auto-resume, login/payment separation, history, no secrets on disk) and `node scripts/test-payments.mjs <baseUrl>` (threshold cases, authorization scope, duplicate begin/complete, rejection, failure and amount exception, history, persistence). Mock merchant pages: `public/mock-checkout.html` (card, separate month/year), `public/mock-subscription.html` (recurring, `MM/YY`), `public/mock-checkout-ach.html` (ACH only).
- Not in this phase (future hardening): protected DOM fields / anti-readback isolation, secret-specific screenshot masking, secure-fill iframes, PCI tokenization or issuing APIs (Stripe Issuing, Lithic, Ramp), merchant adapters, payment routing rules, accounting/bank sync.

## Needs You — the Owner Action Center

`/action-center` is the one page that answers "does anything need me right now?". If it is empty, nothing anywhere is waiting on a human; the owner never has to walk the agent pages, Credentials, Payments or Capabilities to find a blocker.

- **Model** (`src/lib/owner-actions/`): `OwnerAction` — kind (`data`, `approval`, `payment`, `credential`, `capability`, `browser`, `captcha`, `otp`, `signature`, `turn_budget`, `decision`, `other`), agent, task (execution scope), title, reason, `blocking`, timestamps (`createdAt`/`viewedAt`/`resolvedAt`), `sourceRequestType` + `sourceRequestId`, `browserSessionId`, notification state and a kind-specific `payload` (fields, choices, details, turns, href).
- **Coordination, not a second source of truth.** Payments, Credentials, Capabilities, Company info requests and browser handoffs keep their records; `store.ts` projects the open ones into the list on every read (id `"<type>:<id>"`), so nothing is duplicated and existing open requests appeared the moment this shipped — no migration job. Resolving a projection calls the owning service (approve the payment, close the handoff, store the company value), so the authoritative record and the agent resume stay exactly as they were. Only natively-owned kinds are rows here.
- **Tool**: `request_owner_action({ kind, title, reason, blocking?, fields[], choices[], details[] })` — available to every agent, typed rather than free text, always persisted before the agent is parked. `captcha`/`browser`/`otp` open a real handoff of the agent's own session instead of creating a row.
- **Waiting invariant**: a native action parks the agent with `waitingFor = { kind: "owner_action", requestId }`; the action center reconciles on every read, so a resolved, cancelled or orphaned action can never leave a ghost wait.
- **Data actions** render a typed form (text, textarea, number, date, boolean, email, phone, url, select, multi-select, json) with per-field **Save for future**: canonical keys go to the Company Profile, everything else to Company data as **verified** owner-entered values. Several missing values are asked for once, in one form.
- **Turn budget** (`src/lib/runtime/budget.ts`): two levels. At `warnAt` (120 steps) the owner gets a notification and nothing else; at `approveAt` (200) the turn stops, and instead of a red failure the owner is asked to continue (+200, a custom number, until the task completes, or stop). Continuing grants the extra steps to that exact task and resumes it where it stopped.
- **Live browser** (`/browser/sessions/:sessionId/live`, `BrowserLiveView`): external sites cannot be framed, so the viewer is same-origin — it streams frames of the session the agent is already driving and forwards clicks, typing, keys, scrolling and reloads back into it. It is embedded in the action card, in the agent dock and full-screen on phones. Input is refused unless the owner holds control; returning control resumes the agent with an instruction to re-read the page. No new context, no lost cookies, tabs or form state.
- **Notifications** (`notify.ts`): one row per action content hash, so an unchanged action never announces twice. In-app list, live SSE, the browser's own Notification API when permission is granted, and an optional outbound webhook (`NEXORA_PUSH_WEBHOOK`). Every notification deep-links to `/action-center?action=<id>`, never to a dashboard, and never contains a secret.
- **UI**: sidebar entry with a live count (highlighted while something is blocking), blocking items first and review items last, inline forms and approve/decline, and an empty state that states the promise. Works at phone width.
- Tests: `node scripts/test-action-center.mjs <baseUrl>` — data request → form → save-for-future → resume, a second agent reusing the stored value, non-blocking actions never parking an agent, payment and credential projections keeping their owning domain, CAPTCHA using the same BrowserContext, the same-origin viewer, turn-budget grants, notification dedupe and deep links, orphan reconciliation, and the empty-page invariant.

## Autonomy: company data, assumptions and when an agent may interrupt you

The product rule is that an agent finishes the job with the minimum possible owner involvement. `AUTONOMY_RULE` (in `src/lib/runtime/index.ts`, appended to **every** agent's system prompt) makes the order explicit: current task → Company Profile → company data → authorized resources → its own tools → a reversible default → a marked provisional value → and only then the owner. Safe, reversible choices (optional fields, generated usernames and descriptions, language, marketing opt-outs, skippable fields) are decided and reported, never asked. Authoritative values — tax and government identifiers, banking details, registration numbers, signatures, identity or age verification — are never invented. `BROWSER_RULE` sends human-only web steps to `present_browser`, and the credential rule now says to create an account itself and forbids asking the owner to finish a signup and hand over the login.

- **Company data** (`src/lib/company/custom-data.ts`, `db.companyCustomData`): namespaced, typed key/value entries — `signup.default_country`, `google.preferred_username_prefix`, `operations.warehouse_code`. Each carries `valueType` (string, number, boolean, date, url, email, phone, json), `status` (**verified** = the owner stands behind it, **provisional** = an agent chose it), `source`, `reason`, and who created and updated it. Agent writes are always provisional, and an agent cannot overwrite a verified entry — an assumption can never promote itself. Secrets are rejected by key pattern and by value shape (API keys, JWTs, private keys, card numbers) and the refusal names the right home: Credentials, an MCP credential, or Payments.
- **Tools**: `get_company_custom_data({ keys | namespace | search })` with the read permission, `upsert_company_custom_data({ key, value, value_type, reason })` with **Company data: save** (`company_custom_data_manage`). A missing key comes back with an explicit instruction to decide and continue rather than stop.
- **Assumption ledger** (`src/lib/agents/assumptions.ts`, tool `record_assumption`, available to every agent): each reversible choice is recorded with its reason and, where one was stored, the company-data key. Nothing is pushed into the conversation while the agent works; the workspace shows the current task's assumptions above the composer, each linking to the value the owner can correct.
- **Requests can target company data**: `request_company_info` marks a request `profile` or `custom_data`, the waiting status says which ("Add it to Company data"), the card opens that control prefilled, and saving the key resolves the request and resumes the agent.
- UI: **Company → Company data**, a compact searchable table with namespace filter, verified/provisional badges, who added each value, copy, edit, one-click verify and delete.
- Tests: `node scripts/test-autonomy.mjs <baseUrl>` — scenarios A–M (missing optional value never pauses; stored value is found by key, namespace and search; provisional write plus ledger entry; agent cannot self-verify or overwrite verified; secrets rejected for agent and owner; CAPTCHA becomes a handoff with the same BrowserContext; genuine credential and capability gaps still escalate; authoritative legal values are never fabricated; blocking values are bundled; assumptions stay out of the chat; the shared policy forbids the legacy "give me a finished login" behaviour).

## Agent workspace, waiting states and the Browser Dock

The agent page is a workspace, not a document: a compact header, the conversation, and the agent's own browser docked on the right when it asks for you. Configuration lives at `/agents/:id/settings` (Profile · AI Runtime · Tool permissions · Integrations, plus Remove agent) — nothing on the workspace page edits the agent. The page never scrolls; only the transcript does (`AppShell workspace` → `h-[100dvh] overflow-hidden`, `min-h-0` down the tree, `overflow-y-auto` on the transcript alone).

**Waiting states (`src/lib/agents/waiting.ts`).** An agent blocks on four different subsystems, and each used to write its own free-form string into `agent.waitingFor` while the header called all of them "Waiting for capability". The record now holds a typed reference — `{ kind: "capability" | "credential" | "company" | "payment" | "browser", requestId, label, since }` — and every read resolves it against the store that owns it:

- resolved to an OPEN request → headline, owning surface and a deep link (`/credentials?request=<id>`, `/company?request=<id>`, `/payments/requests?request=<id>`, `/capabilities?request=<id>`); the surface highlights and scrolls to that card (`useRequestFocus`).
- resolved to anything else (missing, done, cancelled) → the state is stale and is repaired, not displayed.

`AgentView.waiting` is that resolved view. Requests are always persisted **before** the agent is pointed at them, so a failed creation cannot leave a permanent wait; `reconcileAgentWaiting()` runs at boot and on the agent read paths; `releaseAgentRequests()` cancels an agent's open requests when it is deleted so the owner never sees an unactionable card. Payment requests above the limit now mark the requesting agent too (they never did).

**Browser Dock + human takeover (`src/lib/browser/handoff.ts`, `src/components/agents/BrowserDock.tsx`).** `present_browser({ mode, reason })` is a general tool, not a CAPTCHA workaround: `view` opens the dock while the agent keeps working, `interactive` hands the owner the controls and parks the agent in the `browser` waiting kind. The dock renders the agent's own session (`agent:<id>`) by polling `GET /api/agents/:id/browser`, which screenshots through the same instance and never starts a browser; owner input (`click/type/key/scroll/navigate`) is refused unless an INTERACTIVE handoff is open, so the two can never type at once. Returning control closes the handoff, clears the wait and resumes the agent in its original scope with an instruction to re-read the page. Opening, resizing, collapsing or closing the dock touches no session state.

- Tests: `node scripts/test-agent-waiting.mjs <baseUrl>` — scenarios A–G (real backing request with the right surface and link; resolution clears and resumes; failed creation never waits; a deleted backing request is reconciled away on read; cancellation clears; the Google credential case appears on Credentials and is reachable from the status; requester scoping) plus payment waits and the full browser handoff lifecycle.

## Company Profile

One canonical record of who the company is, so agents never invent business details on a signup or vendor form. Owner-only to edit; agents read it and ask for a genuinely missing value.

- `src/lib/company/` — `types.ts` (`CompanyProfile` singleton: identity incl. the owner / primary contact person (`ownerFirstName`, `ownerLastName`, `ownerTitle`) that forms ask for as "account holder" or "authorized representative", `address`, `billingSameAsCompany` + `billingAddress`, `legal`, `contacts[]`; `CompanyInfoRequest`; `CompanyActivity`), `store.ts` (deterministic validation and normalisation for website/email/phone/EIN/timezone/date/postal code, masking, the canonical `FIELDS` registry, contacts CRUD, the `company` activity channel), `service.ts` (information requests + automatic resume), `tools.ts` (the read-only tool server).
- Read tools (permission **Company profile**, `toolPermissions: company_profile`; the Capability Manager always has it, the CEO gets it by the one-off `ceo-company-profile` migration): `get_company_profile` (full record plus a `missing` list — absent fields are absent, never invented), `get_company_info({fields})` (narrowed to the canonical keys), `request_company_info({field, needed_by, reason})` (SIDE_EFFECT; sets the agent's `waitingFor`, the owner fills it in the UI, the request resolves the moment the field has a value and the agent is resumed in its original scope — Capability Manager requests continue through its own loop via `onCompanyInfoResolved`).
- Write tools (permission **Company profile: update**, `toolPermissions: company_profile_manage`, granted explicitly — not held by the Capability Manager by default): `update_company_profile`, `add_company_contact`, `update_company_contact`, all SIDE_EFFECT and all requiring a `reason`. Agent writes are additive by construction: an empty value is refused rather than clearing a field, addresses are merged into the current one instead of replacing it, contacts can be deactivated but not deleted, and there is no tool that removes anything — clearing and deletion stay with the owner. Every write records the agent id on the row (`updatedBy`, contact `createdBy`) and one activity line with the agent's name and reason, and it resolves any waiting information request whose field it filled (resuming that agent). `COMPANY_WRITE_RULE` in the system prompt limits writes to verified values.
- Contacts carry a purpose description ("Use for sales…", "Use for registrations and company accounts") and one primary per type; agents choose between them by reasoning over name + description, never by position or hardcoded matching.
- Prompt: `COMPANY_RULE` in `src/lib/runtime/index.ts` is appended for every agent with the permission — use the profile as the source of truth, never guess, choose contacts by description, request a missing field instead of fabricating it, never overwrite the profile from external sites.
- Sensitive handling: the tax identifier is stored on the profile but returned to the UI only as `taxIdMasked` (raw value only via `GET /api/company?reveal=taxId`, used by the edit dialog's reveal button); activity records which fields changed and who read the profile, never values.
- UI: **Company → Company Profile** (`/company`) — identity hero, contact methods with purpose text and an "agent-saved" marker, company and billing address cards, masked legal block, live activity showing each agent write with its reason, and "Company information required" cards that open the right edit section; grouped edit dialog (General / Address / Billing / Legal) and a contact dialog. Live via SSE `/api/company/events`.
- API: `/api/company` (GET with optional `?reveal=taxId`, PATCH), `/api/company/contacts`, `/api/company/contacts/:id`, `/api/company/requests/:id` (`{action:"resolve"|"cancel"}`), `/api/company/events`.
- Tests: `node scripts/test-company.mjs <baseUrl>` (profile round-trip with nothing invented, read/write permission isolation, multi-contact metadata, missing legal field → request → auto-resolve → resume, billing same-as/divergent, EIN normalisation + masking + activity hygiene, validation, a full browser signup filled only from the profile, authorized-agent writes with attribution/merge/dedup, refusal to clear or delete, agent-added contacts, and Capability Manager and CEO read access). Mock pages: `public/mock-business-signup.html`, `public/mock-vendor-registry.html`.

## Credential Manager + browser login automation

Company logins agents can use without the owner ever pasting a password into chat. Metadata (name, service, site, login URL, a precise description, masked username, status) lives in `db.loginCredentials`; the password is a hidden vault credential (`login:<id>`, key `PASSWORD`). Agents reason over `list_credentials()` to pick the right entry — there is no exact-match lookup by design.

- `src/lib/credentials/` — `store.ts` (CRUD + masking + vault), `service.ts` (`insertCredentialField` types a field into the agent's own browser session with `sensitive: true`; credential requests; auto-resume; `generatePassword` CSPRNG), `tools.ts` (server `credentials`: use tools `list_credentials`, `get_credential_metadata`, `insert_credential_field`, `insert_credentials`, `request_credential`; manage tools `generate_password` (sensitive result), `save_credential` (description ≥ 20 chars enforced), `update_credential`).
- Permissions: **Credentials: use** (`credentials`) and **Credentials: create & update** (`credentials_manage`). The Capability Manager has both; deletion is owner-only (Credentials page).
- Every agent with credential access gets the mandatory rule in its system prompt: after a value is inserted, never read, inspect, copy or reveal it (assume it was entered correctly; on failure read the site's error, retry once, pick a clearly better credential, or `request_credential`). Insertion is deliberately not deduplicated by the side-effect guard (retries are legitimate); the submit click is the real action.
- Requests: `request_credential` → WAITING (agent flagged "Waiting for capability"); the owner adds the credential on the Credentials page (form prefilled from the request) → RESOLVED → the requester resumes in its original scope; Capability Manager requests wake the manager loop instead.
- Browser snapshots now use Playwright's accessible snapshot with `[ref=eN]` ids (`locator.ariaSnapshot({ mode: "ai" })`, the public successor of the private API Tandem used); the fallback snapshot derives input labels from `<label>` elements.
- UI: **Credentials** page (cards with service glyph, site, description, masked username, status; detail dialog with masked password and usage; add/edit dialog; credential-required cards with "Add Credential"). Live via SSE `/api/logins/events`. API: `/api/logins`, `/api/logins/:id`, `/api/logins/requests/:id/cancel`.
- Tests: `node scripts/test-credentials.mjs <baseUrl>` against the public mock pages `mock-login.html`, `mock-login-steps.html` (email → Next → password) and `mock-signup.html` (signup with simulated email code).
- **Future hardening (not in this MVP):** secure_fill isolation, protected browser elements, secret-aware DOM/screenshot redaction, blocked read-back of inserted values, stronger separation between the model and secret values.

## Skills (selective, per session)

`src/lib/skills/` holds imported engineering documents that the Project Director selects
**per session** — never appended to every agent's system prompt. The library is generated
by `scripts/import-skills.mjs` from a pinned upstream revision and is not edited in place;
Nexora's own commentary rides alongside each document, clearly labelled. Owner view at
Settings → Skills. Full design notes in [docs/skills.md](docs/skills.md).

## Deployment (com.agent24.io)

Runs on the host (not in Docker) because the Claude Code and Codex runtimes spawn the
CLIs, using the logins of the user the service runs as (currently `root`: Claude Code in
`/root/.local/bin`, Codex via `/opt/node22/bin`). Log in once with `claude login` and
`codex login` as that user.

```
/opt/agent24/app                 source + production build (rsync, then `npm ci && npm run build`)
/opt/agent24/data                nexora.json, secrets.json, workspaces (NEXORA_DATA_DIR)
/etc/systemd/system/agent24.service   `next start -H 172.17.0.1 -p 3400` as root
/opt/agent24/docker-compose.yml  socat edge container on traefik_web -> 172.17.0.1:3400,
                                 Traefik labels for com.agent24.io + Let's Encrypt
/opt/agent24/data/auth.json      the app user (set with `npm run auth:set` as root,
                                 NEXORA_DATA_DIR=/opt/agent24/data)
```

Redeploy: rsync the source, rebuild (`npm ci && npm run build` with PATH=/opt/node22/bin), then `systemctl restart agent24`. Chromium for the browser capability: `npx playwright install chromium` as root (cached under `/root/.cache/ms-playwright`).

## Design system direction

- Base: deep navy (`#070b14` → `#0b1220`) with glass panels (`.glass`).
- Department accents: CEO amber, Engineering blue, Operations green, Sales orange,
  Support cyan, Finance purple, Conference indigo. Each is a token
  (`--color-ceo`, `--color-engineering`, …) and is reused by the scene, badges,
  avatars, and widgets so a department reads the same everywhere.
- Type: Geist Sans; tabular numerals via `.num` for metrics.

## The office scene

The centerpiece is an SVG isometric office generated from a floor-plan definition
(`ROOMS` in `OfficeScene.tsx`). Walls are split into 2-unit glass segments and all
furniture/agents are depth-sorted by `x + y` so occlusion works. Wall screens are drawn
inside skewed planes (`WallPlane`) so charts, boards, and text sit flush on walls.
Hovering or clicking a room (or a card in the department strip) highlights it and
opens a department detail card. Five agents walk between departments on looped paths;
the conference room shows a live meeting with a pulsing floor ring and a hologram.
