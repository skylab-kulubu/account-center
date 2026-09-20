import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { noStore, setOidcTransactionCookie } from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { InvalidNativeHandoffError } from "@/server/auth/native-handoff";
import { getAuthServices } from "@/server/auth/services";
import {
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";
import { accountAccessUnavailableResponse } from "@/server/access-gate/http";

export const dynamic = "force-dynamic";

function safeRedirect(response: NextResponse) {
  response.headers.set("Referrer-Policy", "no-referrer");
  return noStore(response);
}

export async function GET(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  const services = getAuthServices();
  const rateLimit = await services.anonymousRateLimit.consume(request, "native_consume");
  if (!rateLimit.allowed) {
    logAuthEvent({ event: "native_handoff_consumed", requestId, outcome: "failure", reason: "rate_limited" });
    const response = NextResponse.json({ error: "too_many_requests" }, { status: 429 });
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return safeRedirect(response);
  }

  const codes = request.nextUrl.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) {
    return safeRedirect(NextResponse.redirect(new URL("/login?error=invalid_request", services.config.appUrl), 303));
  }
  try {
    const result = await services.nativeHandoff.consume(codes[0]);
    const response = NextResponse.redirect(result.authorizationUrl, 303);
    setOidcTransactionCookie(response, result.browserBinding);
    response.headers.set("x-request-id", requestId);
    logAuthEvent({ event: "native_handoff_consumed", requestId, outcome: "success" });
    return safeRedirect(response);
  } catch (error) {
    if (error instanceof AccountAccessUnavailableError) {
      logAuthEvent({
        event: "native_handoff_consumed",
        requestId,
        outcome: "failure",
        reason: "provider_unavailable",
      });
      return safeRedirect(accountAccessUnavailableResponse());
    }
    const invalid = error instanceof InvalidNativeHandoffError ||
      error instanceof AccountAccessBlockedError;
    logAuthEvent({
      event: "native_handoff_consumed",
      requestId,
      outcome: "failure",
      reason: invalid ? "invalid_handoff" : "provider_unavailable",
    });
    const errorCode = invalid ? "invalid_request" : "unavailable";
    return safeRedirect(NextResponse.redirect(new URL(`/login?error=${errorCode}`, services.config.appUrl), 303));
  }
}
