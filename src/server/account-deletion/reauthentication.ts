import "server-only";

import { decodeJwt, decodeProtectedHeader } from "jose";

/**
 * Core's self-delete intake accepts an authentication at most five minutes
 * old, with five seconds of future clock skew. The same window bounds the
 * local intent (`AccountDeletionOrchestrator.createReauthenticatedIntent`),
 * so both sides agree on which ID token is still fresh.
 */
export const DELETION_FRESH_AUTH_WINDOW_MS = 5 * 60 * 1_000;
const FUTURE_SKEW_MS = 5_000;

export type ExpectedDeletionIdentity = {
  issuer: URL;
  clientId: string;
  subject: string;
};

/**
 * What the BFF will present to core as `X-Account-Reauth-Token`.
 * `session_id_token` carries the stored ID token, which already proves an
 * authentication inside the window; `keycloak_reauthentication` means no such
 * token exists and the person has to make one at Keycloak.
 */
export type DeletionReauthentication =
  | { kind: "session_id_token"; idToken: string; authenticatedAt: Date }
  | { kind: "keycloak_reauthentication" };

/**
 * The authentication time an ID token proves, or `null` when the token does
 * not satisfy the contract core verifies on the intake: RS256 `JWT` header,
 * this realm's issuer, this session's subject, `aud` exactly the Account
 * Center client (a string, never an array), a non-empty `sid`, a future
 * integer `exp` and an integer `auth_time` inside the fresh window. Checking
 * it here keeps a token core would reject from ever leaving the BFF.
 */
export function deletionIdTokenAuthenticationTime(
  idToken: string,
  expected: ExpectedDeletionIdentity,
  now: Date = new Date(),
): Date | null {
  let claims: Record<string, unknown>;
  let header: { alg?: string; typ?: string };
  try {
    claims = decodeJwt(idToken) as Record<string, unknown>;
    header = decodeProtectedHeader(idToken);
  } catch {
    return null;
  }
  const authenticationTime = claims.auth_time;
  const expiresAt = claims.exp;
  if (
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    claims.iss !== expected.issuer.href.replace(/\/$/, "") ||
    claims.sub !== expected.subject ||
    claims.aud !== expected.clientId ||
    typeof claims.sid !== "string" ||
    claims.sid.trim().length === 0 ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    typeof authenticationTime !== "number" ||
    !Number.isSafeInteger(authenticationTime) ||
    authenticationTime < 0
  ) return null;
  if (expiresAt * 1_000 <= now.getTime()) return null;
  const authenticatedAt = authenticationTime * 1_000;
  if (
    authenticatedAt > now.getTime() + FUTURE_SKEW_MS ||
    authenticatedAt <= now.getTime() - DELETION_FRESH_AUTH_WINDOW_MS
  ) return null;
  return new Date(authenticatedAt);
}

/**
 * The single branch that decides how account deletion proves a recent
 * authentication to core, and the only place a later contract change lands.
 *
 * Sudo mode is what the person actually goes through: the deletion page asks
 * for a fresh proof (password, passkey, verification code, or the Microsoft
 * fallback) before anything is prepared. Core's intake, however, does not
 * know about sudo yet — it verifies a second JWT next to the Account REST
 * bearer and demands an `auth_time` at most five minutes old. So:
 *
 * - `session_id_token`: the session already holds an ID token inside that
 *   window. This is the state right after Sudo mode's Microsoft fallback,
 *   whose callback replaces the stored token set with the freshly
 *   authenticated one, and right after a Keycloak re-authentication hop.
 *   Nothing else is needed; the person never leaves `my.`.
 * - `keycloak_reauthentication`: the stored ID token proves only the original
 *   login. A silent `prompt=none` round trip would return a token with that
 *   same `auth_time`, so it could not satisfy core either; the flow therefore
 *   keeps the existing `prompt=login&max_age=0` hop
 *   (`POST /api/account/deletion/reauthenticate`) and the page says why.
 *   No token is ever minted or rewritten to look fresher than it is.
 *
 * Follow-up ticket A7b: once core's intake accepts the sky-account sudo token
 * (`X-Sky-Sudo`) in place of a fresh ID token, this branch returns the sudo
 * proof instead of `keycloak_reauthentication`, the hop route and its OIDC
 * purpose are deleted, and the rest of the flow — page steps, intent,
 * idempotency key, receipt cookie, status page — stays exactly as it is.
 */
export function planDeletionReauthentication(
  idToken: string | undefined,
  expected: ExpectedDeletionIdentity,
  now: Date = new Date(),
): DeletionReauthentication {
  if (typeof idToken !== "string" || idToken.length === 0) {
    return { kind: "keycloak_reauthentication" };
  }
  const authenticatedAt = deletionIdTokenAuthenticationTime(idToken, expected, now);
  if (!authenticatedAt) return { kind: "keycloak_reauthentication" };
  return { kind: "session_id_token", idToken, authenticatedAt };
}
