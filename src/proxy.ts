import { Buffer } from "node:buffer";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PROFILE_PICTURE_ORIGIN } from "@/config/club-profile";

const sessionCookie = "__Host-sky-account";
const publicPages = new Set([
  "/login",
  "/account-deletion",
  "/handoff",
  "/v1/native-handoff",
  "/internal/v1/native-handoff/redeem",
]);

function contentSecurityPolicy(nonce: string) {
  const isDevelopment = process.env.NODE_ENV === "development";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    isDevelopment ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self'${isDevelopment ? " ws:" : ""}`,
    `img-src 'self' data: blob: ${PROFILE_PICTURE_ORIGIN}`,
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
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const needsLogin =
    !publicPages.has(request.nextUrl.pathname) &&
    !request.cookies.has(sessionCookie);
  const response = needsLogin
    ? NextResponse.redirect(
        new URL(`/login?returnTo=${encodeURIComponent(request.nextUrl.pathname)}`, request.url),
      )
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|skylab.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
