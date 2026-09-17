/* Shared helpers for the live-model scripts: one login, one runtime pick,
   one way of reporting. Nothing here talks to a model itself. */
/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}

let BASE = "http://localhost:3111";
let cookie = "";

export async function login(base) {
  BASE = base;
  const user = process.env.NEXORA_USER || "mjrafg";
  const pass = requirePassword();
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: pass }) });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
}

export async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""} ${j.detail ?? ""}`);
  return j;
}

/** A runtime that can actually think: the model the company's own agents use. */
export async function findRuntime(prefer = "claude-haiku-4-5") {
  const { agents } = await api("/api/agents");
  const usable = agents.filter((a) => !a.system && a.connection?.status === "connected");
  const live = usable.find((a) => a.runtime?.model === prefer) ?? usable[0];
  if (!live) throw new Error("no agent has a connected provider — a live test cannot run here");
  return { runtimeType: live.runtime.runtimeType, providerConnectionId: live.runtime.providerConnectionId, model: live.runtime.model };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
export function pass(name, ok, note = "") {
  results.push({ name, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
}
export const fail = (name, note) => pass(name, false, note);
export function banner(text) { console.log(`\n=== ${text}\n`); }
export function summary() {
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  if (ok !== results.length) process.exitCode = 1;
}
