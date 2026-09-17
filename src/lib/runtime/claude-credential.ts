/* ------------------------------------------------------------------
   The decisions behind keeping a Claude Code login alive.

   Kept free of imports so every one of them can be exercised directly,
   without a server, a secret store or a call to the provider. What is
   left in logins.ts is the I/O: read the secret, fetch, write it back.
   ------------------------------------------------------------------ */

export type ClaudeCredential = {
  access: string;
  /** absent for a credential captured before refresh existed — it cannot be renewed */
  refresh?: string;
  /** epoch ms; absent when the provider did not say */
  expiresAt?: number;
  obtainedAt?: number;
};

/**
 * Renew a little before the token is actually needed, not a little before it
 * dies: a session that starts valid and runs for forty minutes would otherwise
 * expire mid-turn, which is when it is most expensive to fail.
 */
export const REFRESH_SKEW_MS = 5 * 60_000;

/**
 * The stored credential, in either format.
 *
 * `legacy` is the pre-refresh shape — a bare access token with nothing to
 * renew it. It is still honoured so an upgrade never logs the owner out; it
 * simply cannot be refreshed, which is the whole reason the format changed.
 */
export function parseCredential(raw: string | null, legacy: string | null): ClaudeCredential | null {
  if (raw) {
    try {
      const c = JSON.parse(raw) as ClaudeCredential;
      if (c && typeof c.access === "string" && c.access) return c;
    } catch {
      /* fall through to the legacy key */
    }
  }
  return legacy ? { access: legacy } : null;
}

/** Would this credential still be alive at the end of work lasting `needMs`? */
export function needsRefresh(cred: ClaudeCredential, needMs: number, now: number): boolean {
  if (!cred.refresh) return false; // nothing to refresh with
  if (cred.expiresAt === undefined) return false; // no expiry was given; only a 401 can tell us
  return cred.expiresAt - now <= needMs + REFRESH_SKEW_MS;
}

export type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };

/**
 * The credential to store after a successful exchange or refresh.
 *
 * `previous` matters for one reason: a provider that rotates refresh tokens
 * returns a new one, and a provider that does not returns none. Dropping the
 * old one in the second case would make the NEXT refresh fail permanently —
 * a worse failure than the one this whole change exists to fix.
 */
export function mergeRefreshed(previous: ClaudeCredential | null, res: TokenResponse, now: number): ClaudeCredential | null {
  if (!res.access_token) return previous;
  return {
    access: res.access_token,
    refresh: res.refresh_token ?? previous?.refresh,
    expiresAt: res.expires_in ? now + res.expires_in * 1000 : undefined,
    obtainedAt: now,
  };
}

/**
 * Run `fn` once for everyone who asks while it is still running.
 *
 * The Director, a Builder and a Reviewer can all want a token in the same
 * instant. Refresh tokens rotate, so three simultaneous refreshes would race
 * and two would persist a token the provider had already replaced.
 */
export function singleFlight<T>(): (fn: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (fn) => {
    inFlight ??= (async () => {
      try {
        return await fn();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
