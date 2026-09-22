import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  clearOidcTransactionCookie,
  clearSessionCookie,
  noStore,
  OIDC_TRANSACTION_COOKIE,
  SESSION_COOKIE,
  setSessionCookie,
  setAccountDeletionProofCookie,
  setAccountDeletionReceiptCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { InvalidOidcTransactionError } from "@/server/auth/oidc-flow";
import {
  OidcContractError,
  OidcProviderStageError,
} from "@/server/auth/oidc-protocol";
import { getAuthServices } from "@/server/auth/services";
import { UpstreamSessionExpiredError } from "@/server/auth/sessions";
import { completeSudoReauthentication } from "@/server/auth/sudo-reauthentication";
import { completeYtuLink, YTU_LINK_QUERY } from "@/server/identity/ytu-link";
import {
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";
import { accountAccessUnavailableResponse } from "@/server/access-gate/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  const services = getAuthServices();
  const rateLimit = await services.anonymousRateLimit.consume(request, "callback");
  if (!rateLimit.allowed) {
    const response = NextResponse.json({ error: "too_many_requests" }, { status: 429 });
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return noStore(response);
  }
  try {
    const result = await services.oidc.callback(
      request.nextUrl,
      request.cookies.get(OIDC_TRANSACTION_COOKIE)?.value,
      request.cookies.get(SESSION_COOKIE)?.value,
    );
    if ("sudoReauthentication" in result) {
      const destination = new URL(result.returnTo, services.config.appUrl);
      if (result.sudoReauthentication === "cancelled") {
        destination.searchParams.set("sudo", "cancelled");
      } else {
        // The fresh ID token becomes a sky-account sudo token here and travels no further.
        destination.searchParams.set("sudo", await completeSudoReauthentication(
          services,
          result.session,
          { authenticatedAt: result.authenticatedAt, idToken: result.freshIdToken },
          requestId,
        ));
      }
      const response = NextResponse.redirect(destination, 303);
      clearOidcTransactionCookie(response);
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("x-request-id", requestId);
      return noStore(response);
    }
    if ("ytuLink" in result) {
      const destination = new URL(result.returnTo, services.config.appUrl);
      destination.searchParams.set(
        YTU_LINK_QUERY,
        await completeYtuLink(services, result.session, result.ytuLink, requestId),
      );
      const response = NextResponse.redirect(destination, 303);
      clearOidcTransactionCookie(response);
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("x-request-id", requestId);
      return noStore(response);
    }
    if ("deletionReauthentication" in result) {
      const destination = new URL(result.returnTo, services.config.appUrl);
      if (result.deletionReauthentication === "cancelled") {
        destination.searchParams.set("reauth", "cancelled");
        const response = NextResponse.redirect(destination, 303);
        clearOidcTransactionCookie(response);
        response.headers.set("Referrer-Policy", "no-referrer");
        response.headers.set("x-request-id", requestId);
        return noStore(response);
      }
      if (!services.accountDeletion) throw new Error("account erasure disabled");
      const deletion = await services.accountDeletion.createReauthenticatedIntent({
        session: result.session,
        authenticatedAt: result.authenticatedAt,
        freshAccessToken: result.freshAccessToken,
        freshIdToken: result.freshIdToken,
      });
      destination.searchParams.set("reauth", "confirmed");
      const response = NextResponse.redirect(destination, 303);
      setAccountDeletionProofCookie(response, deletion.proofReference, deletion.freshUntil);
      setAccountDeletionReceiptCookie(response, deletion.localReceipt, deletion.freshUntil);
      clearOidcTransactionCookie(response);
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("x-request-id", requestId);
      return noStore(response);
    }
    await services.sessions.revokeHandle(request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.redirect(new URL(result.returnTo, services.config.appUrl), 303);
    setSessionCookie(response, result.handle, result.absoluteExpiresAt);
    clearOidcTransactionCookie(response);
    response.headers.set("x-request-id", requestId);
    response.headers.set("Referrer-Policy", "no-referrer");
    logAuthEvent({ event: "oidc_login_completed", requestId, outcome: "success" });
    return noStore(response);
  } catch (error) {
    const invalidTransaction = error instanceof InvalidOidcTransactionError;
    const blocked = error instanceof AccountAccessBlockedError;
    const unavailable = error instanceof AccountAccessUnavailableError;
    logAuthEvent({
      event: "oidc_login_failed",
      requestId,
      outcome: "failure",
      reason: invalidTransaction
        ? "invalid_transaction"
        : error instanceof OidcContractError || blocked
          ? "contract_blocked"
          : error instanceof UpstreamSessionExpiredError
            ? "upstream_session_expired"
            : "provider_unavailable",
      ...(error instanceof OidcProviderStageError
        ? { providerStage: error.stage }
        : {}),
    });
    if (unavailable) {
      const response = accountAccessUnavailableResponse();
      clearOidcTransactionCookie(response);
      response.headers.set("x-request-id", requestId);
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    if (blocked) {
      const response = NextResponse.redirect(
        new URL("/login?sessionEnded=1", services.config.appUrl),
        303,
      );
      clearSessionCookie(response);
      clearOidcTransactionCookie(response);
      response.headers.set("x-request-id", requestId);
      response.headers.set("Referrer-Policy", "no-referrer");
      return noStore(response);
    }
    const destination = new URL("/login", services.config.appUrl);
    destination.searchParams.set("error", invalidTransaction ? "invalid_request" : "unavailable");
    const response = NextResponse.redirect(destination, 303);
    clearOidcTransactionCookie(response);
    response.headers.set("x-request-id", requestId);
    response.headers.set("Referrer-Policy", "no-referrer");
    return noStore(response);
  }
}
