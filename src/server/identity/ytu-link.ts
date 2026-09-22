import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import {
  noStore,
  SESSION_COOKIE,
  sessionMutationHasExactOrigin,
  setOidcTransactionCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import type { YtuLinkCallbackStatus } from "@/server/auth/oidc-flow";
import { readBytesBody, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import { requireAccountSpiSudo } from "@/server/auth/sudo-gate";
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
 * How the link ended, as the identity page learns it from `?ytu=`. Only the
 * callback produces these: `linked` after `GET identity` reported
 * `verifiedYtu` (never from `kc_action_status` alone) and `unverified` when
 * Keycloak claimed success but the identity does not show the link, could not
 * be read, or the fresh token set could not be stored. A link that never
 * started (`409 already_linked`, an outage) is answered to the caller as a
 * problem and stays inside the page.
 */
export type YtuLinkOutcome = "linked" | "cancelled" | "error" | "unverified";

/** `200` answer: where the browser must navigate to reach Keycloak. */
export type YtuLinkStartPayload = { authorizationUrl: string };

/** Nothing is read from the body; only a stray small one is tolerated (the proof is the header). */
const MAX_BODY_BYTES = 1_024;

const copy = {
  alreadyLinked: "YTÜ hesabın zaten bağlı.",
} as const;

function startFailureReason(error: unknown): FailureReason {
  if (isReauthenticationRequired(error)) return "invalid_token";
  if (error instanceof SkyAccountUnavailableError) return "provider_unavailable";
  return "contract_blocked";
}

/**
 * `POST /api/account/identity/ytu-link`: starts "YTÜ hesabımı bağla". The
 * link is irreversible (the name and the School e-mail become YTÜ's and
 * cannot be changed here afterwards, and nothing unlinks them), so it runs
 * the same Sudo mode gate as the username change. Order, as in
 * `identityMutation`: exact `Origin` → session CSRF (`x-csrf-token`), access
 * gate and session → Sudo mode gate (`428` with the methods) → local
 * `identity_mutation` budget → `GET identity` (only an unverified account may
 * link; a Verified YTÜ account gets `409 already_linked`) → the `idp_link`
 * transaction bound to this session.
 *
 * The answer is `200 { authorizationUrl }` plus the transaction cookie, and
 * the page navigates there itself: the redirect chain through Keycloak and
 * Microsoft is then an ordinary navigation rather than a form submission,
 * which the page's `form-action` policy would restrict. Every answer carries
 * a rotated handle when one was issued.
 */
export async function startYtuLinkRoute(request: NextRequest) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  if (!sessionMutationHasExactOrigin(request, services.config)) return forbiddenResponse();

  try {
    await readBytesBody(request, {
      maxBytes: MAX_BODY_BYTES,
      contentType: (value) => value === "" || value.split(";", 1)[0]?.trim().toLowerCase() === "application/json",
    });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return problemResponse(status, { error: "invalid_request", detail: identityRouteCopy.invalidRequest });
  }

  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true, requestId },
  );
  if (authorization.status === "forbidden") return forbiddenResponse();
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") return authenticationRequiredResponse();
  const session = authorization.value.session;

  try {
    const gate = await requireAccountSpiSudo(services, session, { requestId });
    if (!gate.ok) {
      logAuthEvent({
        event: "ytu_link_started",
        requestId,
        outcome: "failure",
        reason: gate.reason === "spi_token_required" ? "spi_token_required" : "sudo_required",
      });
      return finish(gate.response, authorization.value);
    }

    const limit = await services.anonymousRateLimit.consumeKey("identity_mutation", session.id);
    if (!limit.allowed) {
      logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason: "rate_limited" });
      return finish(problemResponse(429, {
        error: "rate_limited",
        detail: identityRouteCopy.tooManyAttempts,
        retryAfter: limit.retryAfterSeconds,
      }, { "Retry-After": String(limit.retryAfterSeconds) }), authorization.value);
    }

    const accessToken = await services.account.accessToken(session);
    const { verifiedYtu } = await services.skyAccount.identity({ accessToken });
    if (verifiedYtu) {
      logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason: "already_linked" });
      return finish(problemResponse(409, { error: "already_linked", detail: copy.alreadyLinked }), authorization.value);
    }

    let started;
    try {
      started = await services.oidc.beginYtuLink(session);
    } catch {
      // Discovery, PAR or the transaction store: nothing was started, so the page may simply retry.
      logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason: "provider_unavailable" });
      return finish(problemResponse(503, {
        error: "unavailable",
        detail: identityRouteCopy.unavailable,
      }, { "Retry-After": "3" }), authorization.value);
    }
    const payload: YtuLinkStartPayload = { authorizationUrl: started.authorizationUrl.href };
    const response = noStore(NextResponse.json(payload));
    setOidcTransactionCookie(response, started.browserBinding);
    response.headers.set("Referrer-Policy", "no-referrer");
    logAuthEvent({ event: "ytu_link_started", requestId, outcome: "success" });
    return finish(response, authorization.value);
  } catch (error) {
    const reason = startFailureReason(error);
    logAuthEvent({ event: "ytu_link_started", requestId, outcome: "failure", reason });
    return finish(
      await failureResponse(request, services, session, error),
      authorization.value,
      isReauthenticationRequired(error),
    );
  }
}

/**
 * Turns the callback's outcome into what the page may announce. Keycloak's
 * `success` is verified by reading `GET identity` with the fresh token set:
 * only `verifiedYtu === true` becomes `linked`; a link that does not show, an
 * identity that cannot be read right now, or a token set the flow could not
 * store is `unverified`, and the page shows the server's current state either
 * way.
 */
export async function completeYtuLink(
  services: Pick<Services, "account" | "skyAccount">,
  session: ActiveSession,
  status: YtuLinkCallbackStatus,
  requestId: string,
): Promise<YtuLinkOutcome> {
  if (status === "cancelled") {
    logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "failure", reason: "link_cancelled" });
    return "cancelled";
  }
  if (status === "error") {
    logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "failure", reason: "link_failed" });
    return "error";
  }
  if (status === "unverified") {
    logAuthEvent({ event: "ytu_link_completed", requestId, outcome: "failure", reason: "token_replace_failed" });
    return "unverified";
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
