/* ------------------------------------------------------------------
   Authentication: single local user (Phase 1), scrypt password hash,
   HMAC-signed session cookie. Config lives in data/auth.json (0600),
   created with `npm run auth:set -- <username> <password>`.
   ------------------------------------------------------------------ */

import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "nexora_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const DATA_DIR = process.env.NEXORA_DATA_DIR ?? path.join(process.cwd(), "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

export type AuthConfig = {
  username: string;
  /** scrypt$N$<salt hex>$<hash hex> */
  passwordHash: string;
  sessionSecret: string;
  updatedAt: string;
};

export function readAuthConfig(): AuthConfig | null {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthConfig;
  } catch {
    return null;
  }
}

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !n || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, { N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Create or replace the single user. Keeps the session secret if one exists. */
export function setUser(username: string, password: string): AuthConfig {
  const existing = readAuthConfig();
  const cfg: AuthConfig = {
    username: username.trim(),
    passwordHash: hashPassword(password),
    sessionSecret: existing?.sessionSecret ?? randomBytes(32).toString("hex"),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
  fs.chmodSync(AUTH_FILE, 0o600);
  return cfg;
}

/* ---------- sessions ---------- */

type SessionPayload = { u: string; exp: number; iat: number };

function b64url(buf: Buffer) {
  return buf.toString("base64url");
}

function sign(data: string, secret: string) {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

export function createSessionToken(username: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { u: username, iat: now, exp: now + SESSION_TTL_SECONDS };
  const data = b64url(Buffer.from(JSON.stringify(payload)));
  return `${data}.${sign(data, secret)}`;
}

export function verifySessionToken(token: string | undefined, cfg: AuthConfig | null): { username: string } | null {
  if (!token || !cfg) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = sign(data, cfg.sessionSecret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    // A password change (new hash) does not rotate the secret, but a different username does invalidate.
    if (payload.u !== cfg.username) return null;
    return { username: payload.u };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/* ---------- login rate limiting (per process) ---------- */

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) return { allowed: true, retryAfterSeconds: 0 };
  if (entry.count >= MAX_ATTEMPTS) return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailure(key: string) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export function clearFailures(key: string) {
  attempts.delete(key);
}
