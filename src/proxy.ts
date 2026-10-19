import { Buffer } from "node:buffer";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseProfilePictureOrigin } from "@/config/club-profile";
import {
  automaticLoginTarget,
  LOGIN_REDIRECT_COOKIE,
  LOGIN_REDIRECT_COOKIE_SECONDS,
} from "@/lib/login-redirect";
import { allowedReturnQuery } from "@/lib/return-query";

const sessionCookie = "__Host-sky-account";
/** Read once per process; an invalid value fails the proxy at startup instead of shipping a broken policy. */
const profilePictureOrigin = parseProfilePictureOrigin(process.env.PROFILE_PICTURE_ORIGIN);
const publicPages = new Set(["/login", "/account-deletion"]);
const PREFERENCES_PATH = "/communication-preferences";
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
    // Base UI (skylcn's Switch, Checkbox, Combobox) server-renders its hidden
    // form input with a "visually hidden" style attribute. Only attributes run
    // inline: <style> elements fall back to style-src and keep the nonce, so
    // injected markup still cannot add a selector (CSS exfiltration needs one).
    "style-src-attr 'unsafe-inline'",
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
  const { pathname, searchParams } = request.nextUrl;
  if (isInternalPath(pathname)) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  // Core's unsubscribe page links to the Account center's root with the
  // mail's category (its COMMUNICATION_PREFERENCE_ACCOUNT_CENTER_URL default):
  // that row lives on the preferences screen, signed in or not.
  if (pathname === "/" && searchParams.has("kategori")) {
    const target = PREFERENCES_PATH + allowedReturnQuery(PREFERENCES_PATH, searchParams);
    const response = NextResponse.redirect(new URL(target, request.url));
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }

  // `/login` is a stop only when it has something to say (`login-redirect.ts`);
  // otherwise the person goes straight on to Keycloak with the same returnTo.
  const loginTarget = pathname === "/login"
    ? automaticLoginTarget(searchParams, request.cookies.has(LOGIN_REDIRECT_COOKIE))
    : null;
  if (loginTarget) {
    // A client-side navigation (`<Link>`, `router.replace`) asks for an RSC
    // payload with `fetch`: a redirect would run the login route inside that
    // fetch, set the loop guard there and then fail on Keycloak's cross-origin
    // hop. An empty answer instead makes Next load `/login` as a document,
    // which comes back here without the RSC header.
    if (request.headers.has("rsc")) {
      const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      response.headers.set("Content-Security-Policy", policy);
      return response;
    }
    const response = NextResponse.redirect(new URL(loginTarget, request.url));
    response.cookies.set(LOGIN_REDIRECT_COOKIE, "1", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: LOGIN_REDIRECT_COOKIE_SECONDS,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }

  const needsLogin =
    !publicPages.has(pathname) &&
    !isWellKnownPath(pathname) &&
    !retiredNativeHandoffPaths.has(pathname) &&
    !request.cookies.has(sessionCookie);
  // Only an allow-listed query (`return-query.ts`) survives the login round trip.
  const returnTo = pathname + allowedReturnQuery(pathname, searchParams);
  const response = needsLogin
    ? NextResponse.redirect(
        new URL(`/login?returnTo=${encodeURIComponent(returnTo)}`, request.url),
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
