import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  clearOidcTransactionCookie,
  noStore,
  OIDC_TRANSACTION_COOKIE,
  SESSION_COOKIE,
  setSessionCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { InvalidOidcTransactionError } from "@/server/auth/oidc-flow";
import { OidcContractError } from "@/server/auth/oidc-protocol";
import { getAuthServices } from "@/server/auth/services";

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
    );
    await services.sessions.revokeHandle(request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.redirect(new URL(result.returnTo, services.config.appUrl), 303);
    setSessionCookie(response, result.handle, result.absoluteExpiresAt);
    clearOidcTransactionCookie(response);
    response.headers.set("x-request-id", requestId);
    logAuthEvent({ event: "oidc_login_completed", requestId, outcome: "success" });
    return noStore(response);
  } catch (error) {
    const invalidTransaction = error instanceof InvalidOidcTransactionError;
    logAuthEvent({
      event: "oidc_login_failed",
      requestId,
      outcome: "failure",
      reason: invalidTransaction
        ? "invalid_transaction"
        : error instanceof OidcContractError
          ? "contract_blocked"
          : "provider_unavailable",
    });
    const destination = new URL("/login", services.config.appUrl);
    destination.searchParams.set("error", invalidTransaction ? "invalid_request" : "unavailable");
    const response = NextResponse.redirect(destination, 303);
    clearOidcTransactionCookie(response);
    response.headers.set("x-request-id", requestId);
    return noStore(response);
  }
}
