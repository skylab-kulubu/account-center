import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  mutationHasExactOrigin,
  noStore,
  SESSION_COOKIE,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { readUrlEncodedBody, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import { DeletedSessionTokenDecryptError } from "@/server/auth/sessions";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  const services = getAuthServices();
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  if (!mutationHasExactOrigin(request, services.config)) {
    logAuthEvent({ event: "local_logout", requestId, outcome: "failure", reason: "invalid_csrf" });
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }

  let form: URLSearchParams;
  try {
    form = await readUrlEncodedBody(request, { maxBytes: 1_024, exactContentType: true });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }
  const csrfToken = request.headers.get("x-csrf-token") ?? form.get("csrfToken") ?? undefined;

  const authorization = await services.sessions.authenticateMutation(handle, csrfToken);
  if (authorization.status === "forbidden") {
    logAuthEvent({ event: "local_logout", requestId, outcome: "failure", reason: "invalid_csrf" });
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (authorization.status === "missing") {
    const response = NextResponse.redirect(new URL("/login?loggedOut=1", services.config.appUrl), 303);
    clearSessionCookie(response);
    return noStore(response);
  }

  let tokens;
  try {
    tokens = await services.sessions.deleteSessionAndGetTokens(authorization.value.session.id);
  } catch (error) {
    if (!(error instanceof DeletedSessionTokenDecryptError)) throw error;
    logAuthEvent({
      event: "local_logout",
      requestId,
      outcome: "failure",
      reason: "deleted_token_decrypt_failed",
    });
  }
  if (tokens?.refreshToken) {
    try {
      await services.oidc.revokeRefreshToken(tokens.refreshToken);
    } catch {
      logAuthEvent({
        event: "local_logout",
        requestId,
        outcome: "failure",
        reason: "upstream_revocation_failed",
      });
    }
  }
  const response = NextResponse.redirect(new URL("/login?loggedOut=1", services.config.appUrl), 303);
  clearSessionCookie(response);
  response.headers.set("x-request-id", requestId);
  logAuthEvent({ event: "local_logout", requestId, outcome: "success" });
  return noStore(response);
}
