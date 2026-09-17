export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  checkRateLimit,
  clearFailures,
  createSessionToken,
  readAuthConfig,
  recordFailure,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";

export async function POST(req: Request) {
  const cfg = readAuthConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "No user configured", detail: "Run `npm run auth:set -- <username> <password>` on the server." },
      { status: 503 }
    );
  }
  const key = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${limit.retryAfterSeconds}s.` }, { status: 429 });
  }

  let body: { username?: string; password?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const ok = username.toLowerCase() === cfg.username.toLowerCase() && verifyPassword(password, cfg.passwordHash);
  if (!ok) {
    recordFailure(key);
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }
  clearFailures(key);

  const secure = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  const res = NextResponse.json({ ok: true, user: { username: cfg.username } });
  res.cookies.set(SESSION_COOKIE, createSessionToken(cfg.username, cfg.sessionSecret), sessionCookieOptions(secure));
  return res;
}
