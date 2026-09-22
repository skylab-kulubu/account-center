import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import {
  noStore,
  requestWantsHtmlNavigation,
  SESSION_COOKIE,
  sessionMutationHasExactOrigin,
  setOidcTransactionCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import type { YtuLinkCallbackStatus } from "@/server/auth/oidc-flow";
import { readBytesBody, readUrlEncodedBody, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import type { ActiveSession } from "@/server/auth/types";
import {
  failureResponse,
  finish,
  forbiddenResponse,
  identityRouteCopy,
  isReauthenticationRequired,
  problemResponse,
} from "@/server/identity/routes";
import { SkyAccountUnavailableError } from "@/server/sky-account/client";

type Services = ReturnType<typeof getAuthServices>;
type FailureReason = NonNullable<Parameters<typeof logAuthEvent>[0]["reason"]>;

/** The identity page reads `?ytu=<outcome>` once after the round trip and strips it from the address. */
export const YTU_LINK_QUERY = "ytu";

/**
 * How the link ended, as the identity page learns it from `?ytu=`:
 * `linked` only after `GET identity` reported `verifiedYtu` (never from
 * `kc_action_status` alone), `unverified` when Keycloak claimed success but the
 * identity does not show the link (or could not be read), `already_linked` and
 * `unavailable` when the link could not even start.
 */
export type YtuLinkOutcome =
  | "linked"
  | "cancelled"
  | "error"
  | "unverified"
  | "already_linked"
  | "unavailable";

/** `200` answer of a fetch caller: where the browser must navigate to reach Keycloak. */
export type YtuLinkStartPayload = { authorizationUrl: string };

const RETURN_TO = "/identity";
/** `csrfToken=` form field or an empty / small JSON body; nothing else is read. */
const MAX_BODY_BYTES = 1_024;

const copy = {
  alreadyLinked: "YTÜ hesabın zaten bağlı.",
} as const;

function redirectWithOutcome(services: Pick<Services, "config">, outcome: YtuLinkOutcome) {
  const destination = new URL(RETURN_TO, services.config.appUrl);
  destination.searchParams.set(YTU_LINK_QUERY, outcome);
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  return noStore(response);
}

/**
 * The CSRF proof of the request: the `csrfToken` field of a form navigation,
 * or the `x-csrf-token` header of a fetch caller (whose body, if any, is
 * ignored). Anything larger than a form field is refused before the session
 * is looked up.
 */
async function readCsrfProof(request: NextRequest): Promise<string | undefined> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType === "application/x-www-form-urlencoded") {
    const form = await readUrlEncodedBody(request, { maxBytes: MAX_BODY_BYTES });
    return form.get("csrfToken") ?? undefined;
  }
  await readBytesBody(request, {
    maxBytes: MAX_BODY_BYTES,
    contentType: (value) => value === "" || value.split(";", 1)[0]?.trim().toLowerCase() === "application/json",
  });
  return request.headers.get("x-csrf-token") ?? undefined;
}

function startFailureReason(error: unknown): FailureReason {
  if (isReauthenticationRequired(error)) return "invalid_token";
  if (error instanceof SkyAccountUnavailableError) return "provider_unavailable";
  return "contract_blocked";
}

/**
 * `POST /api/account/identity/ytu-link`: starts "YTÜ hesabımı bağla". Order:
 * exact `Origin` → body and CSRF proof → access gate and session → local
 * `identity_mutation` budget → `GET identity` (only an unverified account may
 * link; a Verified YTÜ account gets `409 already_linked`) → the `idp_link`
 * transaction bound to this session. A browser navigation (the form) is sent
 * to Keycloak with `303`; a fetch caller receives `200 { authorizationUrl }`
 * and navigates itself, so the redirect chain through Keycloak and Microsoft
 * is an ordinary navigation rather than a form submission. Both answers carry
 * the transaction cookie. Failures answer JSON problems to a fetch caller and
 * `?ytu=already_linked|unavailable` to a navigation.
 */
export async function startYtuLinkRoute(request: NextRequest) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const htmlNavigation = requestWantsHtmlNavigation(request);
  if (!sessionMutationHasExactOrigin(request, services.config)) return forbiddenResponse();

  let csrfToken: string | undefined;
  try {
    csrfToken = await readCsrfProof(request);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return problemResponse(status, { error: "invalid_request", detail: identityRouteCopy.invalidRequest });
  }

  const unavailable = () => {
    if (!htmlNavigation) {
      return problemResponse(503, { error: "unavailable", detail: identityRouteCopy.unavailable }, { "Retry-After": "3" });
    }
    const response = redirectWithOutcome(services, "unavailable");
    response.headers.set("Retry-After", "3");
    return response;
  };

  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    csrfToken,
    { allowRotation: true, requestId },
  );
  if (authorization.status === "forbidden") return forbiddenResponse();
  if (authorization.status === "missing") return authenticationRequiredResponse();
  if (authorization.status === "unavailable") {
    return htmlNavigation ? unavailable() : accountAccessUnavailableResponse();
  }
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  const session = authorization.value.session;

  const limit = await services.anonymousRateLimit.consumeKey("identity_mutation", session.id);
  if (!limit.allowed) {
    logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason: "rate_limited" });
    if (htmlNavigation) {
      const response = redirectWithOutcome(services, "unavailable");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return finish(response, authorization.value);
    }
    return finish(problemResponse(429, {
      error: "rate_limited",
      detail: identityRouteCopy.tooManyAttempts,
      retryAfter: limit.retryAfterSeconds,
    }, { "Retry-After": String(limit.retryAfterSeconds) }), authorization.value);
  }

  let verifiedYtu: boolean;
  try {
    const accessToken = await services.account.accessToken(session);
    ({ verifiedYtu } = await services.skyAccount.identity({ accessToken }));
  } catch (error) {
    const reason = startFailureReason(error);
    logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason });
    if (reason === "invalid_token") {
      return finish(await failureResponse(request, services, session, error), authorization.value, true);
    }
    return finish(htmlNavigation ? unavailable() : await failureResponse(request, services, session, error), authorization.value);
  }
  if (verifiedYtu) {
    logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason: "already_linked" });
    if (htmlNavigation) return finish(redirectWithOutcome(services, "already_linked"), authorization.value);
    return finish(problemResponse(409, { error: "already_linked", detail: copy.alreadyLinked }), authorization.value);
  }

  try {
    const started = await services.oidc.beginYtuLink(session);
    const response = htmlNavigation
      ? NextResponse.redirect(started.authorizationUrl, 303)
      : NextResponse.json({ authorizationUrl: started.authorizationUrl.href } satisfies YtuLinkStartPayload);
    setOidcTransactionCookie(response, started.browserBinding);
    response.headers.set("Referrer-Policy", "no-referrer");
    logAuthEvent({ event: "ytu_link_started", requestId, outcome: "success" });
    return finish(noStore(response), authorization.value);
  } catch {
    logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason: "provider_unavailable" });
    return finish(unavailable(), authorization.value);
  }
}

/**
 * Turns the callback's `kc_action_status` into what the page may announce.
 * Keycloak's `success` is verified by reading `GET identity` with the fresh
 * token set: only `verifiedYtu === true` becomes `linked`; a link that does
 * not show (or an identity that cannot be read right now) is `unverified`,
 * and the page shows the server's current state either way.
 */
export async function completeYtuLink(
  services: Pick<Services, "account" | "skyAccount">,
  session: ActiveSession,
  status: YtuLinkCallbackStatus,
  requestId: string,
): Promise<Exclude<YtuLinkOutcome, "already_linked" | "unavailable">> {
  if (status === "cancelled") {
    logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "failure", reason: "link_cancelled" });
    return "cancelled";
  }
  if (status === "error") {
    logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "failure", reason: "link_failed" });
    return "error";
  }
  let verifiedYtu: boolean;
  try {
    const accessToken = await services.account.accessToken(session);
    ({ verifiedYtu } = await services.skyAccount.identity({ accessToken }));
  } catch (error) {
    logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "failure", reason: startFailureReason(error) });
    return "unverified";
  }
  if (!verifiedYtu) {
    logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "failure", reason: "link_unverified" });
    return "unverified";
  }
  logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "success" });
  return "linked";
}
