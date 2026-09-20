import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { nativeRequestHasSafeOrigin, noStore } from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { InvalidNativeHandoffError } from "@/server/auth/native-handoff";
import { InvalidNativeAccessTokenError } from "@/server/auth/native-handoff-token";
import { readUtf8Body, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import {
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";
import { accountAccessUnavailableResponse } from "@/server/access-gate/http";

export const dynamic = "force-dynamic";

function bearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  return match?.[1];
}

export async function POST(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  const services = getAuthServices();
  if (!nativeRequestHasSafeOrigin(request, services.config)) {
    logAuthEvent({ event: "native_handoff_created", requestId, outcome: "failure", reason: "invalid_origin" });
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  const token = bearerToken(request);
  if (!token) return noStore(NextResponse.json({ error: "invalid_token" }, { status: 401 }));
  try {
    const body = await readUtf8Body(request, { maxBytes: 2 });
    if (body.length !== 0) return noStore(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }
  const rateLimit = await services.anonymousRateLimit.consume(request, "native_create");
  if (!rateLimit.allowed) {
    logAuthEvent({ event: "native_handoff_created", requestId, outcome: "failure", reason: "rate_limited" });
    const response = NextResponse.json({ error: "too_many_requests" }, { status: 429 });
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return noStore(response);
  }

  try {
    const handoff = await services.nativeHandoff.create(token);
    logAuthEvent({ event: "native_handoff_created", requestId, outcome: "success" });
    const response = NextResponse.json(handoff, { status: 201 });
    response.headers.set("x-request-id", requestId);
    return noStore(response);
  } catch (error) {
    const invalid = error instanceof InvalidNativeAccessTokenError ||
      error instanceof InvalidNativeHandoffError ||
      error instanceof AccountAccessBlockedError;
    if (error instanceof AccountAccessUnavailableError) {
      logAuthEvent({
        event: "native_handoff_created",
        requestId,
        outcome: "failure",
        reason: "provider_unavailable",
      });
      return accountAccessUnavailableResponse();
    }
    logAuthEvent({
      event: "native_handoff_created",
      requestId,
      outcome: "failure",
      reason: invalid ? "invalid_token" : "provider_unavailable",
    });
    return noStore(NextResponse.json(
      { error: invalid ? "invalid_token" : "temporarily_unavailable" },
      { status: invalid ? 401 : 503 },
    ));
  }
}
