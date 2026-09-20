import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  mutationHasExactOrigin,
  noStore,
  SESSION_COOKIE,
  setOidcTransactionCookie,
  setSessionCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { InvalidAccountActionError } from "@/server/auth/oidc-flow";
import { readUrlEncodedBody, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import type { AccountActionKind } from "@/server/auth/types";

export const dynamic = "force-dynamic";

const allowedKinds = new Set<AccountActionKind>([
  "password",
  "otp",
  "passkey",
  "delete-credential",
]);

export async function POST(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  const services = getAuthServices();
  if (!mutationHasExactOrigin(request, services.config)) {
    logAuthEvent({ event: "account_action_started", requestId, outcome: "failure", reason: "invalid_origin" });
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }

  let form: URLSearchParams;
  try {
    form = await readUrlEncodedBody(request, { maxBytes: 2_048, exactContentType: true });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }

  const kind = form.get("action");
  if (!kind || !allowedKinds.has(kind as AccountActionKind)) {
    return noStore(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  }
  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    form.get("csrfToken") ?? undefined,
    { allowRotation: true, requestId },
  );
  if (authorization.status === "forbidden") {
    logAuthEvent({ event: "account_action_started", requestId, outcome: "failure", reason: "invalid_csrf" });
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (authorization.status === "missing") return authenticationRequiredResponse();
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") {
    return authenticationRequiredResponse(true);
  }

  try {
    const action = await services.oidc.beginAccountAction(
      {
        kind: kind as AccountActionKind,
        ...(kind === "delete-credential"
          ? { deletionReference: form.get("credential") ?? undefined }
          : {}),
      },
      authorization.value.session,
    );
    const response = NextResponse.redirect(action.authorizationUrl, 303);
    setOidcTransactionCookie(response, action.browserBinding);
    if (authorization.value.rotatedHandle) {
      setSessionCookie(
        response,
        authorization.value.rotatedHandle,
        authorization.value.session.absoluteExpiresAt,
      );
    }
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("x-request-id", requestId);
    logAuthEvent({ event: "account_action_started", requestId, outcome: "success" });
    return noStore(response);
  } catch (error) {
    logAuthEvent({
      event: "account_action_started",
      requestId,
      outcome: "failure",
      reason: error instanceof InvalidAccountActionError ? "invalid_account_action" : "provider_unavailable",
    });
    let response: NextResponse;
    if (error instanceof InvalidAccountActionError) {
      response = NextResponse.json({ error: "invalid_request" }, { status: 400 });
    } else {
      const destination = new URL("/security", services.config.appUrl);
      const resultReference = await services.actionResults.create(
        authorization.value.session.id,
        { action: kind as AccountActionKind, outcome: "error" },
      ).catch(() => null);
      if (resultReference) destination.searchParams.set("result", resultReference);
      response = NextResponse.redirect(destination, 303);
    }
    if (authorization.value.rotatedHandle) {
      setSessionCookie(
        response,
        authorization.value.rotatedHandle,
        authorization.value.session.absoluteExpiresAt,
      );
    }
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("x-request-id", requestId);
    return noStore(response);
  }
}
