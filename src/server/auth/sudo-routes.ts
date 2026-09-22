import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import {
  mutationHasExactOrigin,
  noStore,
  requestWantsHtmlNavigation,
  SESSION_COOKIE,
  sessionMutationHasExactOrigin,
  setOidcTransactionCookie,
  setSessionCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { normalizeReturnTo } from "@/server/auth/oidc-flow";
import { readUrlEncodedBody, readUtf8Body, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import { SudoSessionInactiveError } from "@/server/auth/sudo";
import type { SudoMethod, SudoProofMethod } from "@/server/auth/sudo";
import { resolveSudoMethods } from "@/server/auth/sudo-methods";
import type { BrowserSession } from "@/server/auth/types";
import {
  AccountAccessTokenContractError,
  AccountAccessTokenExpiredError,
} from "@/server/keycloak-account/access-token";
import { KeycloakAccountUnauthorizedError } from "@/server/keycloak-account/adapter";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import {
  parseWebauthnAssertion,
  SkyAccountContractError,
  SkyAccountInvalidInputError,
  SkyAccountProblem,
  SkyAccountUnavailableError,
} from "@/server/sky-account/client";
import type { BearerAuthorization, SkyAccountClient, SudoGrant } from "@/server/sky-account/client";

type Services = ReturnType<typeof getAuthServices>;

/** `{ password }` / `{ code }` bodies; a passkey assertion may carry up to 64 KB (contract). */
const MAX_PROOF_BODY_BYTES = 2 * 1_024;
const MAX_ASSERTION_BODY_BYTES = 64 * 1_024;
const MAX_PASSWORD_LENGTH = 1_024;
const TOTP_CODE = /^\d{4,10}$/;
const JSON_CONTENT_TYPE = "application/json";

/**
 * Body of every non-2xx answer of the sudo routes: a stable `error` key the
 * dialog branches on and a Turkish `detail` it may show. `retryAfter` (seconds)
 * accompanies lockouts and rate limits. Passwords, codes, assertions and sudo
 * tokens never appear in any answer.
 */
export type SudoRouteProblem = {
  error:
    | "invalid_request"
    | "invalid_credentials"
    | "locked"
    | "disabled"
    | "rate_limited"
    | "method_unavailable"
    | "method_available"
    | "challenge_expired"
    | "unavailable"
    | "upstream_error"
    | "unexpected";
  detail: string;
  retryAfter?: number;
};

export type SudoMethodsPayload = {
  methods: SudoMethod[];
  fallback: "microsoft" | null;
  active: { method: SudoProofMethod; expiresAt: string } | null;
  csrfToken: string;
};

export type SudoGrantPayload = {
  method: SudoMethod;
  expiresAt: string;
};

const copy = {
  invalidRequest: "İstek anlaşılamadı. Sayfayı yenileyip yeniden dene.",
  unavailable: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden dene.",
  contract: "Kimlik hizmetinin yanıtı desteklenen sürümle eşleşmedi. Doğrulama yapılmadı.",
  unexpected: "Beklenmeyen bir sorun oluştu. Doğrulama yapılmadı.",
  tooManyAttempts: "Çok fazla deneme yaptın. Biraz sonra yeniden dene.",
  methodAvailable: "Hesabında parola, passkey ya da doğrulama uygulaması var; kimliğini onlarla doğrula. Microsoft ile yeniden doğrulama yalnız hiçbiri olmayanlar içindir.",
} as const;

class SudoRequestError extends Error {
  constructor(readonly status: 400 | 413) {
    super("Invalid sudo request body.");
    this.name = "SudoRequestError";
  }
}

function problemResponse(
  status: number,
  problem: SudoRouteProblem,
  headers: Record<string, string> = {},
) {
  return noStore(NextResponse.json(problem, { status, headers }));
}

function retryAfterHeaders(seconds: number | null | undefined): Record<string, string> {
  return seconds !== null && seconds !== undefined && seconds > 0
    ? { "Retry-After": String(Math.ceil(seconds)) }
    : {};
}

function isReauthenticationRequired(error: unknown) {
  return (
    error instanceof AccountReauthenticationRequiredError ||
    error instanceof AccountAccessTokenExpiredError ||
    error instanceof KeycloakAccountUnauthorizedError ||
    error instanceof SudoSessionInactiveError ||
    (error instanceof SkyAccountProblem && error.code === "unauthorized")
  );
}

/**
 * Maps a failure to the browser answer. Rejections of the person's own bearer
 * (refresh impossible, Keycloak or the SPI no longer accept the token) end
 * the local session like the other account routes do, so the shell sends the
 * person back to login instead of looping on a dead token.
 */
async function failureResponse(
  request: NextRequest,
  services: Pick<Services, "sessions">,
  session: { id: string } | null,
  error: unknown,
): Promise<NextResponse> {
  const requestId = requestCorrelationId(request);
  if (isReauthenticationRequired(error)) {
    const response = authenticationRequiredResponse(true);
    if (session) {
      try {
        await services.sessions.revokeSession(session.id);
      } catch {
        logAuthEvent({
          event: "account_session_cleanup",
          requestId,
          outcome: "failure",
          reason: "local_session_revocation_failed",
        });
      }
    }
    return response;
  }
  if (error instanceof SudoRequestError) {
    return problemResponse(error.status, { error: "invalid_request", detail: copy.invalidRequest });
  }
  if (error instanceof SkyAccountInvalidInputError) {
    return problemResponse(400, { error: "invalid_request", detail: copy.invalidRequest });
  }
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "invalid_credentials":
      case "webauthn_invalid":
      case "webauthn_origin_not_allowed":
        return problemResponse(401, { error: "invalid_credentials", detail: error.detail });
      case "user_temporarily_locked":
        return problemResponse(423, {
          error: "locked",
          detail: error.detail,
          ...(error.retryAfter !== null ? { retryAfter: error.retryAfter } : {}),
        }, retryAfterHeaders(error.retryAfter));
      case "user_disabled":
        return problemResponse(403, { error: "disabled", detail: error.detail });
      case "rate_limited":
        return problemResponse(429, {
          error: "rate_limited",
          detail: error.detail,
          ...(error.retryAfter !== null ? { retryAfter: error.retryAfter } : {}),
        }, retryAfterHeaders(error.retryAfter));
      case "password_not_configured":
      case "totp_not_configured":
      case "passkey_not_registered":
        return problemResponse(400, { error: "method_unavailable", detail: error.detail });
      case "webauthn_challenge_expired":
        return problemResponse(400, { error: "challenge_expired", detail: error.detail });
      case "invalid_request":
        return problemResponse(400, { error: "invalid_request", detail: error.detail });
      case "webauthn_not_configured":
      case "unmanaged_attributes_enabled":
        return problemResponse(503, { error: "unavailable", detail: error.detail }, { "Retry-After": "60" });
      default:
        return problemResponse(502, { error: "upstream_error", detail: copy.contract });
    }
  }
  if (error instanceof SkyAccountUnavailableError) {
    return problemResponse(503, { error: "unavailable", detail: copy.unavailable }, { "Retry-After": "3" });
  }
  if (
    error instanceof SkyAccountContractError ||
    error instanceof AccountAccessTokenContractError
  ) {
    return problemResponse(502, { error: "upstream_error", detail: copy.contract });
  }
  return problemResponse(500, { error: "unexpected", detail: copy.unexpected });
}

function failureReason(error: unknown): NonNullable<Parameters<typeof logAuthEvent>[0]["reason"]> {
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "invalid_credentials":
      case "webauthn_invalid":
      case "webauthn_origin_not_allowed":
        return "invalid_credentials";
      case "user_temporarily_locked":
      case "user_disabled":
        return "user_locked";
      case "rate_limited":
        return "rate_limited";
      case "password_not_configured":
      case "totp_not_configured":
      case "passkey_not_registered":
        return "method_unavailable";
      default:
        return "contract_blocked";
    }
  }
  if (error instanceof SudoRequestError || error instanceof SkyAccountInvalidInputError) return "contract_blocked";
  if (error instanceof SkyAccountUnavailableError) return "provider_unavailable";
  if (error instanceof SudoSessionInactiveError) return "sudo_storage_failed";
  return "contract_blocked";
}

function forbiddenResponse() {
  return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
}

/**
 * Applies a rotated opaque handle to the answer. A rejected proof (wrong
 * password, lockout, rate limit) still belongs to a live session, so the new
 * handle must reach the browser or the next attempt would be sent with a
 * handle that is already past its grace window. Only an answer that ended
 * the session (`sessionEnded`, decided from the error, never from the status
 * code) withholds it, because that answer clears the cookie instead.
 */
function finish(response: NextResponse, authorization: BrowserSession, sessionEnded = false) {
  if (authorization.rotatedHandle && !sessionEnded) {
    setSessionCookie(response, authorization.rotatedHandle, authorization.session.absoluteExpiresAt);
  }
  return response;
}

type MutationAuthorization =
  | { ok: true; value: BrowserSession }
  | { ok: false; response: NextResponse };

async function authenticateSudoMutation(request: NextRequest, services: Services): Promise<MutationAuthorization> {
  if (!sessionMutationHasExactOrigin(request, services.config)) return { ok: false, response: forbiddenResponse() };
  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true, requestId: requestCorrelationId(request) },
  );
  if (authorization.status === "forbidden") return { ok: false, response: forbiddenResponse() };
  if (authorization.status === "unavailable") return { ok: false, response: accountAccessUnavailableResponse() };
  if (authorization.status === "blocked") return { ok: false, response: authenticationRequiredResponse(true) };
  if (authorization.status !== "active") return { ok: false, response: authenticationRequiredResponse() };
  return { ok: true, value: authorization.value };
}

async function readJsonBody(request: NextRequest, maxBytes: number): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readUtf8Body(request, { maxBytes, exactContentType: JSON_CONTENT_TYPE });
  } catch (error) {
    throw new SudoRequestError(error instanceof RequestBodyError ? error.status : 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SudoRequestError(400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SudoRequestError(400);
  return value as Record<string, unknown>;
}

async function rateLimited(
  services: Services,
  scope: "sudo" | "sudo_options",
  sessionId: string,
): Promise<NextResponse | null> {
  const limit = await services.anonymousRateLimit.consumeKey(scope, sessionId);
  if (limit.allowed) return null;
  return problemResponse(429, {
    error: "rate_limited",
    detail: copy.tooManyAttempts,
    retryAfter: limit.retryAfterSeconds,
  }, { "Retry-After": String(limit.retryAfterSeconds) });
}

/** `GET /api/account/sudo/methods`: which proofs the person can use, whether one is already fresh, and the CSRF proof. */
export async function sudoMethodsRoute(request: NextRequest) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const authorization = await services.sessionAccess.authenticate(
    request.cookies.get(SESSION_COOKIE)?.value,
    { requestId },
  );
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") return authenticationRequiredResponse();

  const session = authorization.value.session;
  try {
    const [availability, active] = await Promise.all([
      resolveSudoMethods(services, session),
      services.sudo.currentSudo(session.id, { requestId }),
    ]);
    const payload: SudoMethodsPayload = {
      methods: availability.methods,
      fallback: availability.fallback,
      active: active ? { method: active.method, expiresAt: active.expiresAt.toISOString() } : null,
      csrfToken: services.sessions.csrfToken(session.id),
    };
    return noStore(NextResponse.json(payload));
  } catch (error) {
    return failureResponse(request, services, session, error);
  }
}

/** `POST /api/account/sudo/webauthn/options`: assertion options for `navigator.credentials.get()`. */
export async function sudoWebauthnOptionsRoute(request: NextRequest) {
  const services = getAuthServices();
  const authorization = await authenticateSudoMutation(request, services);
  if (!authorization.ok) return authorization.response;
  const session = authorization.value.session;
  try {
    const limited = await rateLimited(services, "sudo_options", session.id);
    if (limited) return finish(limited, authorization.value);
    const accessToken = await services.account.accessToken(session);
    const options = await services.skyAccount.sudoWebauthnOptions({ accessToken });
    return finish(noStore(NextResponse.json(options)), authorization.value);
  } catch (error) {
    return finish(
      await failureResponse(request, services, session, error),
      authorization.value,
      isReauthenticationRequired(error),
    );
  }
}

type SudoProver = (
  client: Pick<SkyAccountClient, "sudoPassword" | "sudoTotp" | "sudoWebauthnVerify">,
  auth: BearerAuthorization,
  body: Record<string, unknown>,
) => Promise<SudoGrant>;

function requirePassword(body: Record<string, unknown>) {
  const password = body.password;
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw new SudoRequestError(400);
  }
  return password;
}

function requireCode(body: Record<string, unknown>) {
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
  if (!TOTP_CODE.test(code)) throw new SudoRequestError(400);
  return code;
}

const provers: Record<SudoMethod, { maxBytes: number; prove: SudoProver }> = {
  password: {
    maxBytes: MAX_PROOF_BODY_BYTES,
    prove: (client, auth, body) => client.sudoPassword(auth, { password: requirePassword(body) }),
  },
  totp: {
    maxBytes: MAX_PROOF_BODY_BYTES,
    prove: (client, auth, body) => client.sudoTotp(auth, { code: requireCode(body) }),
  },
  passkey: {
    maxBytes: MAX_ASSERTION_BODY_BYTES,
    prove: (client, auth, body) => {
      const assertion = parseWebauthnAssertion(body.assertion);
      if (!assertion) throw new SudoRequestError(400);
      return client.sudoWebauthnVerify(auth, assertion);
    },
  },
};

/**
 * `POST /api/account/sudo/password|totp|webauthn/verify`: proves sudo with
 * the sky-account SPI and keeps the returned token in the encrypted session
 * record. The answer carries only the deadline and the method.
 */
export async function sudoProofRoute(request: NextRequest, method: SudoMethod) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const authorization = await authenticateSudoMutation(request, services);
  if (!authorization.ok) return authorization.response;
  const session = authorization.value.session;
  const prover = provers[method];
  try {
    const limited = await rateLimited(services, "sudo", session.id);
    if (limited) {
      logAuthEvent({ event: "sudo_attempt", requestId, outcome: "failure", reason: "rate_limited", sudoMethod: method });
      return finish(limited, authorization.value);
    }
    const body = await readJsonBody(request, prover.maxBytes);
    const accessToken = await services.account.accessToken(session);
    const grant = await prover.prove(services.skyAccount, { accessToken }, body);
    await services.sudo.storeSudo(session.id, grant.sudoToken, grant.expiresAt, method);
    logAuthEvent({ event: "sudo_attempt", requestId, outcome: "success", sudoMethod: method });
    const payload: SudoGrantPayload = { method, expiresAt: grant.expiresAt.toISOString() };
    return finish(noStore(NextResponse.json(payload)), authorization.value);
  } catch (error) {
    logAuthEvent({
      event: "sudo_attempt",
      requestId,
      outcome: "failure",
      reason: failureReason(error),
      sudoMethod: method,
    });
    return finish(
      await failureResponse(request, services, session, error),
      authorization.value,
      isReauthenticationRequired(error),
    );
  }
}

/**
 * `POST /api/account/sudo/reauthenticate` (form): the Microsoft fallback for a
 * person without password, passkey or TOTP. Allowed only when `GET identity`
 * shows none of the three (`fallback: "microsoft"`); a person who has one
 * gets `409 method_available` (or `?sudo=method_available` on a navigation)
 * and proves inside `my.` instead. Starts a forced re-authentication bound to
 * this session; the callback marks sudo for five minutes and returns to
 * `returnTo` with `?sudo=confirmed|cancelled|unavailable`.
 */
export async function sudoReauthenticateRoute(request: NextRequest) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const htmlNavigation = requestWantsHtmlNavigation(request);
  if (!mutationHasExactOrigin(request, services.config)) return forbiddenResponse();
  let form: URLSearchParams;
  try {
    form = await readUrlEncodedBody(request, { maxBytes: 1_024, exactContentType: true });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }
  const returnTo = normalizeReturnTo(form.get("returnTo"));
  const unavailable = () => {
    if (!htmlNavigation) {
      return noStore(NextResponse.json({ error: "unavailable" }, {
        status: 503,
        headers: { "Retry-After": "3" },
      }));
    }
    const destination = new URL(returnTo, services.config.appUrl);
    destination.searchParams.set("sudo", "unavailable");
    const response = NextResponse.redirect(destination, 303);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Retry-After", "3");
    return noStore(response);
  };
  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    form.get("csrfToken") ?? undefined,
    { allowRotation: true, requestId },
  );
  if (authorization.status === "forbidden") return forbiddenResponse();
  if (authorization.status === "missing") return authenticationRequiredResponse();
  if (authorization.status === "unavailable") {
    return htmlNavigation ? unavailable() : accountAccessUnavailableResponse();
  }
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  const session = authorization.value.session;

  let availability;
  try {
    availability = await resolveSudoMethods(services, session);
  } catch (error) {
    logAuthEvent({
      event: "sudo_reauthentication_started",
      requestId,
      outcome: "failure",
      reason: isReauthenticationRequired(error) ? "invalid_token" : "provider_unavailable",
      sudoMethod: "reauth",
    });
    if (isReauthenticationRequired(error)) {
      return finish(await failureResponse(request, services, session, error), authorization.value, true);
    }
    return finish(unavailable(), authorization.value);
  }
  if (availability.fallback !== "microsoft") {
    logAuthEvent({
      event: "sudo_reauthentication_started",
      requestId,
      outcome: "failure",
      reason: "method_available",
      sudoMethod: "reauth",
    });
    if (!htmlNavigation) {
      return finish(problemResponse(409, { error: "method_available", detail: copy.methodAvailable }), authorization.value);
    }
    const destination = new URL(returnTo, services.config.appUrl);
    destination.searchParams.set("sudo", "method_available");
    const response = NextResponse.redirect(destination, 303);
    response.headers.set("Referrer-Policy", "no-referrer");
    return finish(noStore(response), authorization.value);
  }

  try {
    const started = await services.oidc.beginSudoReauthentication(session, returnTo);
    const response = NextResponse.redirect(started.authorizationUrl, 303);
    setOidcTransactionCookie(response, started.browserBinding);
    response.headers.set("Referrer-Policy", "no-referrer");
    logAuthEvent({ event: "sudo_reauthentication_started", requestId, outcome: "success", sudoMethod: "reauth" });
    return finish(noStore(response), authorization.value);
  } catch {
    logAuthEvent({
      event: "sudo_reauthentication_started",
      requestId,
      outcome: "failure",
      reason: "provider_unavailable",
      sudoMethod: "reauth",
    });
    return finish(unavailable(), authorization.value);
  }
}
