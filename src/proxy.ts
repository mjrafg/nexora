import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig, verifySessionToken, SESSION_COOKIE } from "@/lib/auth";

// /mock-checkout.html is a static test merchant page used by the Payments regression flow
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/me", "/mock-checkout.html", "/mock-business-signup.html", "/mock-vendor-registry.html", "/mock-checkout-ach.html", "/mock-subscription.html", "/mock-login.html", "/mock-login-steps.html", "/mock-signup.html"];
// token-authenticated machine callbacks (the Director MCP server)
const INTERNAL_PREFIX = "/api/internal/";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith(INTERNAL_PREFIX)) return NextResponse.next();

  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, readAuthConfig());
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  const next = pathname + search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$).*)"],
};
