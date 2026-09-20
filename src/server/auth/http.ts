import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import type { AuthConfig } from "@/server/auth/config";

export const SESSION_COOKIE = "__Host-sky-account";
export const OIDC_TRANSACTION_COOKIE = "__Host-sky-account-txn";
export const ACCOUNT_DELETION_PROOF_COOKIE = "__Host-sky-account-delete-proof";
export const ACCOUNT_DELETION_RECEIPT_COOKIE = "__Host-sky-account-delete-receipt";

const baseCookie = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  priority: "high" as const,
};

export function setSessionCookie(
  response: NextResponse,
  handle: string,
  absoluteExpiresAt: Date,
) {
  response.cookies.set(SESSION_COOKIE, handle, {
    ...baseCookie,
    expires: absoluteExpiresAt,
    maxAge: Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1_000)),
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", { ...baseCookie, expires: new Date(0), maxAge: 0 });
}

export function setOidcTransactionCookie(response: NextResponse, browserBinding: string) {
  response.cookies.set(OIDC_TRANSACTION_COOKIE, browserBinding, {
    ...baseCookie,
    maxAge: 5 * 60,
  });
}

export function clearOidcTransactionCookie(response: NextResponse) {
  response.cookies.set(OIDC_TRANSACTION_COOKIE, "", { ...baseCookie, expires: new Date(0), maxAge: 0 });
}

export function setAccountDeletionProofCookie(
  response: NextResponse,
  proof: string,
  expiresAt: Date,
) {
  response.cookies.set(ACCOUNT_DELETION_PROOF_COOKIE, proof, {
    ...baseCookie,
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)),
  });
}

export function clearAccountDeletionProofCookie(response: NextResponse) {
  response.cookies.set(
    ACCOUNT_DELETION_PROOF_COOKIE,
    "",
    { ...baseCookie, expires: new Date(0), maxAge: 0 },
  );
}

export function setAccountDeletionReceiptCookie(
  response: NextResponse,
  receipt: string,
  expiresAt: Date,
) {
  response.cookies.set(ACCOUNT_DELETION_RECEIPT_COOKIE, receipt, {
    ...baseCookie,
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)),
  });
}

export function clearAccountDeletionReceiptCookie(response: NextResponse) {
  response.cookies.set(
    ACCOUNT_DELETION_RECEIPT_COOKIE,
    "",
    { ...baseCookie, expires: new Date(0), maxAge: 0 },
  );
}

export function mutationHasExactOrigin(request: NextRequest, config: AuthConfig) {
  const origin = request.headers.get("origin");
  if (origin !== config.appUrl.origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin";
}

export function requestWantsHtmlNavigation(request: NextRequest) {
  if (
    request.headers.get("sec-fetch-mode") !== "navigate" ||
    request.headers.get("sec-fetch-dest") !== "document"
  ) return false;
  return (request.headers.get("accept") ?? "")
    .split(",")
    .some((value) => value.split(";", 1)[0]?.trim().toLowerCase() === "text/html");
}

/**
 * Session revocation requires the browser's serialized Origin to be byte-for-byte
 * identical to the configured origin. Do not URL-normalize this boundary: values
 * containing credentials, paths, a trailing slash, or alternate port/case
 * serialization are not valid browser Origin header values for this contract.
 */
export function sessionMutationHasExactOrigin(request: NextRequest, config: AuthConfig) {
  if (request.headers.get("origin") !== config.appUrl.origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin";
}

export function nativeRequestHasSafeOrigin(request: NextRequest, config: AuthConfig) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin && !fetchSite) return true;
  return origin === config.appUrl.origin && fetchSite === "same-origin";
}

export function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}
