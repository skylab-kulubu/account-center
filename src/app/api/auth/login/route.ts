import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { noStore, setOidcTransactionCookie } from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import {
  OidcContractError,
  OidcProviderStageError,
} from "@/server/auth/oidc-protocol";
import { getAuthServices } from "@/server/auth/services";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  const services = getAuthServices();
  const rateLimit = await services.anonymousRateLimit.consume(request, "login");
  if (!rateLimit.allowed) {
    const response = NextResponse.json({ error: "too_many_requests" }, { status: 429 });
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return noStore(response);
  }
  try {
    const authorization = await services.oidc.begin(
      request.nextUrl.searchParams.get("returnTo"),
    );
    logAuthEvent({ event: "oidc_login_started", requestId, outcome: "success" });
    const response = NextResponse.redirect(authorization.authorizationUrl, 303);
    setOidcTransactionCookie(response, authorization.browserBinding);
    response.headers.set("x-request-id", requestId);
    return noStore(response);
  } catch (error) {
    logAuthEvent({
      event: "oidc_login_failed",
      requestId,
      outcome: "failure",
      reason: error instanceof OidcContractError ? "contract_blocked" : "provider_unavailable",
      ...(error instanceof OidcProviderStageError
        ? { providerStage: error.stage }
        : {}),
    });
    const destination = new URL("/login", request.url);
    destination.searchParams.set("error", "unavailable");
    const response = NextResponse.redirect(destination, 303);
    response.headers.set("x-request-id", requestId);
    return noStore(response);
  }
}
