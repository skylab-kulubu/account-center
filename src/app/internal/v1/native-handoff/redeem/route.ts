import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { noStore } from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { InvalidNativeBridgeRequestError } from "@/server/auth/native-bridge-auth";
import { InvalidNativeHandoffError } from "@/server/auth/native-handoff";
import { readUtf8Body, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import {
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";
import { accountAccessUnavailableResponse } from "@/server/access-gate/http";

export const dynamic = "force-dynamic";

function bridgeCode(body: string) {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidNativeHandoffError();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("code" in value) ||
    typeof value.code !== "string"
  ) throw new InvalidNativeHandoffError();
  return value.code;
}

export async function POST(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  const services = getAuthServices();
  if (request.nextUrl.search) {
    logAuthEvent({
      event: "native_bridge_redeemed",
      requestId,
      outcome: "failure",
      reason: "invalid_bridge_request",
    });
    return noStore(NextResponse.json({ error: "invalid_request" }, { status: 401 }));
  }
  let body: string;
  try {
    body = await readUtf8Body(request, { maxBytes: 256, exactContentType: "application/json" });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }

  let proof: { requestNonceHash: Buffer; requestNonceExpiresAt: Date };
  try {
    proof = services.nativeBridgeRequest.verify({
      method: request.method,
      path: request.nextUrl.pathname,
      body,
      headers: request.headers,
    });
  } catch (error) {
    logAuthEvent({
      event: "native_bridge_redeemed",
      requestId,
      outcome: "failure",
      reason: error instanceof InvalidNativeBridgeRequestError
        ? "invalid_bridge_request"
        : "provider_unavailable",
    });
    return noStore(NextResponse.json({ error: "invalid_request" }, { status: 401 }));
  }

  const rateLimit = await services.anonymousRateLimit.consumeKey(
    "native_redeem",
    "keycloak-native-authenticator",
  );
  if (!rateLimit.allowed) {
    logAuthEvent({ event: "native_bridge_redeemed", requestId, outcome: "failure", reason: "rate_limited" });
    const response = NextResponse.json({ error: "too_many_requests" }, { status: 429 });
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return noStore(response);
  }

  try {
    const redeemed = await services.nativeHandoff.redeem(bridgeCode(body), proof);
    logAuthEvent({ event: "native_bridge_redeemed", requestId, outcome: "success" });
    return noStore(NextResponse.json({
      sub: redeemed.subject,
      sid: redeemed.keycloakSid,
      auth_time: Math.floor(redeemed.authenticatedAt.getTime() / 1_000),
    }));
  } catch (error) {
    const invalid = error instanceof InvalidNativeHandoffError ||
      error instanceof AccountAccessBlockedError;
    if (error instanceof AccountAccessUnavailableError) {
      logAuthEvent({
        event: "native_bridge_redeemed",
        requestId,
        outcome: "failure",
        reason: "provider_unavailable",
      });
      return accountAccessUnavailableResponse();
    }
    logAuthEvent({
      event: "native_bridge_redeemed",
      requestId,
      outcome: "failure",
      reason: invalid ? "invalid_handoff" : "provider_unavailable",
    });
    return noStore(NextResponse.json(
      { error: invalid ? "invalid_request" : "temporarily_unavailable" },
      { status: invalid ? 400 : 503 },
    ));
  }
}
