#!/usr/bin/env node
/* ------------------------------------------------------------------
   Keeping a Claude Code login alive.

   Nexora used to store only the access half of the OAuth credential and
   throw away the refresh token, so every Director, Builder and Reviewer
   turn started failing with "401 OAuth access token has expired" a few
   hours after the owner signed in — and with no native CLI login to fall
   back on, the only cure was signing in again.

   These check the decisions behind renewing it: when to renew, what to
   keep when the provider rotates the refresh token, that an upgrade
   never logs the owner out, and that three agents wanting a token at
   once produce one refresh rather than three.

     node --experimental-strip-types scripts/test-claude-auth.mjs
   ------------------------------------------------------------------ */

const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}

const { parseCredential, needsRefresh, mergeRefreshed, singleFlight, REFRESH_SKEW_MS } =
  await import("../src/lib/runtime/claude-credential.ts");

const NOW = 1_700_000_000_000;
const mins = (n) => n * 60_000;

await test("an upgrade from the old format keeps the owner signed in", async () => {
  const c = parseCredential(null, "legacy-access-token");
  assert(c?.access === "legacy-access-token", "the pre-refresh credential was dropped");
  assert(!c.refresh, "a refresh token was invented from nowhere");
  assert(c.expiresAt === undefined, "an expiry was invented from nowhere");
  return "bare token honoured, nothing fabricated";
});

await test("the new format wins over the old one, and junk falls back", async () => {
  const both = parseCredential(JSON.stringify({ access: "new", refresh: "r" }), "old");
  assert(both.access === "new" && both.refresh === "r", "the stale copy was preferred");
  assert(parseCredential("{not json", "old")?.access === "old", "corrupt JSON lost a usable credential");
  assert(parseCredential(JSON.stringify({ refresh: "r" }), null) === null, "a credential with no access token was accepted");
  assert(parseCredential(null, null) === null, "something was returned when nothing is stored");
  return "new > legacy > nothing";
});

await test("a token that would die mid-turn is renewed before the turn starts", async () => {
  const cred = { access: "a", refresh: "r", expiresAt: NOW + mins(30) };
  assert(!needsRefresh(cred, 0, NOW), "renewed a token with half an hour left for a turn needing nothing");
  assert(!needsRefresh(cred, mins(20), NOW), "renewed a token that comfortably outlasts a 20-minute turn");
  // a 30-minute turn against 30 minutes of life: it expires at the finish line
  assert(needsRefresh(cred, mins(30), NOW), "let a turn start on a token that expires before it ends");
  assert(needsRefresh(cred, mins(26), NOW), `the ${REFRESH_SKEW_MS / 60_000}-minute margin was not applied`);
  return "the turn's own length decides, not the clock alone";
});

await test("a credential with nothing to renew it is never sent to the refresh endpoint", async () => {
  assert(!needsRefresh({ access: "a", expiresAt: NOW - mins(60) }, 0, NOW), "tried to refresh a credential with no refresh token");
  assert(!needsRefresh({ access: "a", refresh: "r" }, mins(60), NOW), "refreshed on an unknown expiry rather than waiting for a 401");
  return "no refresh token and no expiry both mean leave it alone";
});

await test("an expired credential is renewed, not abandoned", async () => {
  assert(needsRefresh({ access: "a", refresh: "r", expiresAt: NOW - mins(1) }, 0, NOW), "an expired credential was left expired");
  return "past expiry still triggers a renewal";
});

await test("a rotated refresh token replaces the old one; an unrotated one survives", async () => {
  const prev = { access: "a1", refresh: "r1", expiresAt: NOW };
  const rotated = mergeRefreshed(prev, { access_token: "a2", refresh_token: "r2", expires_in: 3600 }, NOW);
  assert(rotated.access === "a2" && rotated.refresh === "r2", "rotation was not persisted");
  assert(rotated.expiresAt === NOW + 3_600_000, `expiry not recorded: ${rotated.expiresAt}`);
  // the failure that would be worse than the bug: losing the only refresh token
  const kept = mergeRefreshed(prev, { access_token: "a3", expires_in: 3600 }, NOW);
  assert(kept.refresh === "r1", "the refresh token was dropped when the provider did not send a new one");
  return "r1 → r2 when rotated, r1 kept when not";
});

await test("a refusal never overwrites a credential that still works", async () => {
  const prev = { access: "a1", refresh: "r1", expiresAt: NOW };
  assert(mergeRefreshed(prev, {}, NOW) === prev, "a response with no access token replaced the stored credential");
  assert(mergeRefreshed(prev, { refresh_token: "r9" }, NOW) === prev, "a half-response was accepted");
  return "no access token in, nothing changed";
});

await test("a provider that reports no expiry leaves the 401 path to decide", async () => {
  const c = mergeRefreshed(null, { access_token: "a", refresh_token: "r" }, NOW);
  assert(c.expiresAt === undefined, "an expiry was invented");
  assert(!needsRefresh(c, mins(60), NOW), "guessed at renewal timing with no expiry to go on");
  return "unknown expiry stays unknown";
});

await test("three agents wanting a token at once cause one refresh, not three", async () => {
  const once = singleFlight();
  let calls = 0;
  const refresh = async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return { access: `a${calls}` }; };
  const [x, y, z] = await Promise.all([once(refresh), once(refresh), once(refresh)]);
  assert(calls === 1, `${calls} concurrent refreshes — rotation would have raced`);
  assert(x.access === y.access && y.access === z.access, "callers got different credentials from one refresh");
  // and the next one, after it settles, is free to refresh again
  await once(refresh);
  assert(calls === 2, `a later refresh was blocked by the finished one (calls=${calls})`);
  return "1 refresh for 3 callers, unlocked afterwards";
});

await test("a failing refresh does not wedge the lock", async () => {
  const once = singleFlight();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("network"); };
  await once(boom).catch(() => {});
  await once(boom).catch(() => {});
  assert(calls === 2, "the single-flight lock stayed held after a rejection");
  return "a rejection releases it";
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
