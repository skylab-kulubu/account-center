import { Buffer } from "node:buffer";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseProfilePictureOrigin } from "@/config/club-profile";

const sessionCookie = "__Host-sky-account";
/** Read once per process; an invalid value fails the proxy at startup instead of shipping a broken policy. */
const profilePictureOrigin = parseProfilePictureOrigin(process.env.PROFILE_PICTURE_ORIGIN);
const publicPages = new Set(["/login", "/account-deletion"]);
/**
 * The retired native handoff endpoints (ADR-0048). No route answers them any
 * more; skipping the login redirect lets the router say 404, so an old SkyApp
 * build or a leftover handoff link never shows a login form inside its
 * WebView. It needs no database table; keep it while SkyApp builds that
 * still call these paths may be installed. The third one,
 * `/internal/v1/native-handoff/redeem`, falls under `isInternalPath`.
 */
const retiredNativeHandoffPaths = new Set(["/handoff", "/v1/native-handoff"]);

/**
 * Account Center has no internal routes left (the native handoff redeem
 * endpoint was the last, retired with ADR-0048), so everything under
 * `/internal` answers a bare 404 before the session check, whichever way the
 * request arrived. There is no in-cluster caller to tell apart from a request
 * that came through the public edge, so no forwarding header is consulted:
 * a route added under `app/internal` later stays unreachable until this
 * guard is changed on purpose.
 */
function isInternalPath(pathname: string) {
  return pathname === "/internal" || pathname.startsWith("/internal/");
}

/**
 * `/.well-known` is for machines (Android Digital Asset Links, Apple App Site
 * Association): the app answers it itself, with the file or a 404, never
 * with a redirect to the login page.
 */
function isWellKnownPath(pathname: string) {
  return pathname === "/.well-known" || pathname.startsWith("/.well-known/");
}

function contentSecurityPolicy(nonce: string) {
  const isDevelopment = process.env.NODE_ENV === "development";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    isDevelopment ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self'${isDevelopment ? " ws:" : ""}`,
    `img-src 'self' data: blob: ${profilePictureOrigin}`,
    "font-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://e.yildizskylab.com",
    "frame-ancestors 'none'",
    ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isInternalPath(pathname)) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const needsLogin =
    !publicPages.has(pathname) &&
    !isWellKnownPath(pathname) &&
    !retiredNativeHandoffPaths.has(pathname) &&
    !request.cookies.has(sessionCookie);
  const response = needsLogin
    ? NextResponse.redirect(
        new URL(`/login?returnTo=${encodeURIComponent(pathname)}`, request.url),
      )
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    // Without the prefetch exclusion below: the /internal 404 holds for every request.
    "/internal/:path*",
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|skylab.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
