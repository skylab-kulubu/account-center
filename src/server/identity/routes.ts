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
  setSessionCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { readUtf8Body, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import { requireAccountSpiSudo, sudoRequiredResponse } from "@/server/auth/sudo-gate";
import { resolveSudoMethods } from "@/server/auth/sudo-methods";
import type { BrowserSession } from "@/server/auth/types";
import {
  CoreProfileContractError,
  CoreProfileUnauthorizedError,
  CoreProfileUnavailableError,
} from "@/server/core/profile-client";
import { identityView } from "@/server/identity/view";
import type { IdentityPayload } from "@/server/identity/view";
import {
  checkPersonName,
  checkUsername,
  isPersonNameField,
  personNameMessage,
  usernameMessage,
} from "@/lib/identity-fields";
import type { PersonNameField } from "@/lib/identity-fields";
import {
  AccountAccessTokenContractError,
  AccountAccessTokenExpiredError,
} from "@/server/keycloak-account/access-token";
import { KeycloakAccountUnauthorizedError } from "@/server/keycloak-account/adapter";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import {
  SkyAccountContractError,
  SkyAccountInvalidInputError,
  SkyAccountProblem,
  SkyAccountUnavailableError,
} from "@/server/sky-account/client";

type Services = ReturnType<typeof getAuthServices>;
type Session = BrowserSession["session"];
type IdentityAction = NonNullable<Parameters<typeof logAuthEvent>[0]["identityAction"]>;
type FailureReason = NonNullable<Parameters<typeof logAuthEvent>[0]["reason"]>;

const JSON_CONTENT_TYPE = "application/json";
/** `{ firstName, lastName }` and `{ username }` bodies. */
const MAX_BODY_BYTES = 4 * 1_024;

/**
 * Body of every non-2xx answer of the identity routes (except the `428` sudo
 * challenge and the session answers): a stable `error` key the page branches
 * on and a Turkish `detail` it may show. `field` names the rejected form
 * field, `retryAfter` (seconds) accompanies rate limits, lockouts and the
 * username cooldown, `availableAt` (ISO instant) the cooldown only. Names,
 * usernames and tokens never appear in any error answer or log line.
 */
export type IdentityRouteProblem = {
  error:
    | "invalid_request"
    | "invalid_name"
    | "invalid_username"
    | "name_locked"
    | "username_taken"
    | "username_cooldown"
    | "already_linked"
    | "locked"
    | "disabled"
    | "rate_limited"
    | "unavailable"
    | "upstream_error"
    | "unexpected";
  detail: string;
  field?: PersonNameField | "username";
  retryAfter?: number;
  availableAt?: string;
};

/**
 * `200` answer of `PATCH …/identity/name`. Keycloak accepted the name; the
 * core shadow was updated in the same action (`synced`), could not be
 * (`failed`, logged as `identity_name_core_sync_failed` for follow-up), or
 * this environment has no core (`disabled`).
 */
export type NameChangePayload = { coreSync: "synced" | "failed" | "disabled" };

export const identityRouteCopy = {
  invalidRequest: "İstek anlaşılamadı. Sayfayı yenileyip yeniden dene.",
  unavailable: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden dene.",
  contract: "Kimlik hizmetinin yanıtı desteklenen sürümle eşleşmedi. Değişiklik yapılmadı.",
  unexpected: "Beklenmeyen bir sorun oluştu. Değişiklik yapılmadı.",
  tooManyAttempts: "Çok fazla deneme yaptın. Biraz sonra yeniden dene.",
} as const;
const copy = identityRouteCopy;

class IdentityRequestError extends Error {
  constructor(readonly status: 400 | 413) {
    super("Invalid identity request body.");
    this.name = "IdentityRequestError";
  }
}

/** A field refused by the shared rules before anything was sent upstream. */
class IdentityFieldError extends Error {
  constructor(
    readonly field: PersonNameField | "username",
    readonly detail: string,
  ) {
    super(`The identity field ${field} is invalid.`);
    this.name = "IdentityFieldError";
  }
}

export function problemResponse(
  status: number,
  problem: IdentityRouteProblem,
  headers: Record<string, string> = {},
) {
  return noStore(NextResponse.json(problem, { status, headers }));
}

export function forbiddenResponse() {
  return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
}

function retryAfterHeaders(seconds: number | null | undefined): Record<string, string> {
  return seconds !== null && seconds !== undefined && seconds > 0
    ? { "Retry-After": String(Math.ceil(seconds)) }
    : {};
}

export function isReauthenticationRequired(error: unknown) {
  return (
    error instanceof AccountReauthenticationRequiredError ||
    error instanceof AccountAccessTokenExpiredError ||
    error instanceof KeycloakAccountUnauthorizedError ||
    (error instanceof SkyAccountProblem && error.code === "unauthorized")
  );
}

/** The SPI no longer accepts the stored proof: the local copy is stale and must not be offered again. */
function isSudoRejectedUpstream(error: unknown) {
  return error instanceof SkyAccountProblem && (error.code === "sudo_required" || error.code === "sudo_expired");
}

/**
 * Applies a rotated opaque handle to the answer, except to one that ended the
 * session (decided from the error, never from the status code), because that
 * answer clears the cookie instead.
 */
export function finish(response: NextResponse, authorization: BrowserSession, sessionEnded = false) {
  if (authorization.rotatedHandle && !sessionEnded) {
    setSessionCookie(response, authorization.rotatedHandle, authorization.session.absoluteExpiresAt);
  }
  return response;
}

async function endSession(request: NextRequest, services: Pick<Services, "sessions">, session: { id: string }) {
  const response = authenticationRequiredResponse(true);
  try {
    await services.sessions.revokeSession(session.id);
  } catch {
    logAuthEvent({
      event: "account_session_cleanup",
      requestId: requestCorrelationId(request),
      outcome: "failure",
      reason: "local_session_revocation_failed",
    });
  }
  return response;
}

function problemField(error: SkyAccountProblem): Pick<IdentityRouteProblem, "field"> {
  return isPersonNameField(error.field) ? { field: error.field } : {};
}

/**
 * Maps a failure to the browser answer. Rejections of the person's own bearer
 * end the local session; a proof the SPI rejects is discarded locally and
 * answered with the same `428` challenge the gate sends; the SPI's identity
 * rules (`invalid_name`, `invalid_username`, `name_locked`, `username_taken`,
 * `username_cooldown`) keep their status and Turkish `detail`.
 */
export async function failureResponse(
  request: NextRequest,
  services: Services,
  session: Session,
  error: unknown,
): Promise<NextResponse> {
  if (isReauthenticationRequired(error)) return endSession(request, services, session);
  if (isSudoRejectedUpstream(error)) {
    await services.sudo.clearSudo(session.id).catch(() => undefined);
    const availability = await resolveSudoMethods(services, session).catch(() => null);
    if (!availability) {
      return problemResponse(503, { error: "unavailable", detail: copy.unavailable }, { "Retry-After": "3" });
    }
    return sudoRequiredResponse({ reason: "expired", ...availability });
  }
  if (error instanceof IdentityRequestError) {
    return problemResponse(error.status, { error: "invalid_request", detail: copy.invalidRequest });
  }
  if (error instanceof IdentityFieldError) {
    return problemResponse(400, {
      error: error.field === "username" ? "invalid_username" : "invalid_name",
      detail: error.detail,
      field: error.field,
    });
  }
  if (error instanceof SkyAccountInvalidInputError) {
    return problemResponse(400, { error: "invalid_request", detail: copy.invalidRequest });
  }
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "invalid_name":
        return problemResponse(400, { error: "invalid_name", detail: error.detail, ...problemField(error) });
      case "invalid_username":
        return problemResponse(400, { error: "invalid_username", detail: error.detail, field: "username" });
      case "name_locked":
        return problemResponse(403, { error: "name_locked", detail: error.detail });
      case "username_taken":
        return problemResponse(409, { error: "username_taken", detail: error.detail, field: "username" });
      case "username_cooldown":
        return problemResponse(409, {
          error: "username_cooldown",
          detail: error.detail,
          ...(error.retryAfter !== null ? { retryAfter: error.retryAfter } : {}),
          ...(error.availableAt !== null ? { availableAt: error.availableAt.toISOString() } : {}),
        }, retryAfterHeaders(error.retryAfter));
      case "invalid_request":
        return problemResponse(400, { error: "invalid_request", detail: error.detail });
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
      case "unmanaged_attributes_enabled":
        return problemResponse(503, { error: "unavailable", detail: error.detail }, { "Retry-After": "60" });
      default:
        return problemResponse(502, { error: "upstream_error", detail: copy.contract });
    }
  }
  if (error instanceof SkyAccountUnavailableError) {
    return problemResponse(503, { error: "unavailable", detail: copy.unavailable }, { "Retry-After": "3" });
  }
  if (error instanceof SkyAccountContractError || error instanceof AccountAccessTokenContractError) {
    return problemResponse(502, { error: "upstream_error", detail: copy.contract });
  }
  return problemResponse(500, { error: "unexpected", detail: copy.unexpected });
}

function failureReason(error: unknown): FailureReason {
  if (isReauthenticationRequired(error)) return "invalid_token";
  if (isSudoRejectedUpstream(error)) return "sudo_rejected_upstream";
  if (error instanceof IdentityFieldError) return error.field === "username" ? "invalid_username" : "invalid_name";
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "invalid_name":
        return "invalid_name";
      case "invalid_username":
        return "invalid_username";
      case "name_locked":
        return "name_locked";
      case "username_taken":
        return "username_taken";
      case "username_cooldown":
        return "username_cooldown";
      case "rate_limited":
        return "rate_limited";
      case "user_temporarily_locked":
      case "user_disabled":
        return "user_locked";
      case "unmanaged_attributes_enabled":
        return "provider_unavailable";
      default:
        return "contract_blocked";
    }
  }
  if (error instanceof SkyAccountUnavailableError) return "provider_unavailable";
  return "contract_blocked";
}

type MutationAuthorization =
  | { ok: true; value: BrowserSession }
  | { ok: false; response: NextResponse };

/** Exact `Origin`, then the session-bound CSRF proof, the access gate and the session; shared with the e-mail routes. */
export async function authenticateMutation(request: NextRequest, services: Services): Promise<MutationAuthorization> {
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

/** A small JSON object body (≤ 4 KB); anything else is answered `400` / `413 invalid_request` by `failureResponse`. */
export async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readUtf8Body(request, { maxBytes: MAX_BODY_BYTES, exactContentType: JSON_CONTENT_TYPE });
  } catch (error) {
    throw new IdentityRequestError(error instanceof RequestBodyError ? error.status : 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IdentityRequestError(400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new IdentityRequestError(400);
  return value as Record<string, unknown>;
}

async function rateLimited(services: Services, sessionId: string): Promise<NextResponse | null> {
  const limit = await services.anonymousRateLimit.consumeKey("identity_mutation", sessionId);
  if (limit.allowed) return null;
  return problemResponse(429, {
    error: "rate_limited",
    detail: copy.tooManyAttempts,
    retryAfter: limit.retryAfterSeconds,
  }, { "Retry-After": String(limit.retryAfterSeconds) });
}

function requirePersonName(body: Record<string, unknown>, field: PersonNameField) {
  const check = checkPersonName(body[field]);
  if (!check.ok) throw new IdentityFieldError(field, personNameMessage(field, check.reason));
  return check.value;
}

function requireUsername(body: Record<string, unknown>) {
  const check = checkUsername(body.username);
  if (!check.ok) throw new IdentityFieldError("username", usernameMessage(check.reason));
  return check.value;
}

type BearerAuth = { accessToken: string };
type SudoAuth = BearerAuth & { sudoToken: string };
type Operate<Auth extends BearerAuth> = (services: Services, session: Session, auth: Auth) => Promise<NextResponse>;

/**
 * Runs one identity mutation: exact origin, session CSRF, access gate and
 * session first; then, for the username, the Sudo mode gate (`428` when no
 * proof with SPI material is fresh); then the local `identity_mutation`
 * budget; only then the body is read and the SPI called. Every answer
 * carries a rotated handle when one was issued.
 */
function identityMutation(request: NextRequest, action: "name", operate: Operate<BearerAuth>): Promise<NextResponse>;
function identityMutation(request: NextRequest, action: "username", operate: Operate<SudoAuth>): Promise<NextResponse>;
async function identityMutation(
  request: NextRequest,
  action: IdentityAction,
  operate: Operate<BearerAuth> | Operate<SudoAuth>,
): Promise<NextResponse> {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const authorization = await authenticateMutation(request, services);
  if (!authorization.ok) return authorization.response;
  const session = authorization.value.session;
  try {
    let sudo: Pick<SudoAuth, "sudoToken"> | null = null;
    if (action === "username") {
      const gate = await requireAccountSpiSudo(services, session, { requestId });
      if (!gate.ok) {
        logAuthEvent({
          event: "identity_action",
          requestId,
          outcome: "failure",
          reason: gate.reason === "spi_token_required" ? "spi_token_required" : "sudo_required",
          identityAction: action,
        });
        return finish(gate.response, authorization.value);
      }
      sudo = { sudoToken: gate.proof.sudoToken };
    }
    const limited = await rateLimited(services, session.id);
    if (limited) {
      logAuthEvent({ event: "identity_action", requestId, outcome: "failure", reason: "rate_limited", identityAction: action });
      return finish(limited, authorization.value);
    }
    const accessToken = await services.account.accessToken(session);
    // The overloads guarantee a sudo-carrying `operate` only for the username action, which the gate above served.
    const response = await (operate as Operate<BearerAuth>)(services, session, { accessToken, ...sudo });
    logAuthEvent({ event: "identity_action", requestId, outcome: "success", identityAction: action });
    return finish(response, authorization.value);
  } catch (error) {
    logAuthEvent({
      event: "identity_action",
      requestId,
      outcome: "failure",
      reason: failureReason(error),
      identityAction: action,
    });
    return finish(
      await failureResponse(request, services, session, error),
      authorization.value,
      isReauthenticationRequired(error),
    );
  }
}

function coreSyncFailureReason(error: unknown): FailureReason {
  if (error instanceof CoreProfileUnavailableError) return "provider_unavailable";
  if (error instanceof CoreProfileUnauthorizedError) return "invalid_token";
  if (error instanceof CoreProfileContractError) return "contract_blocked";
  return "core_rejected";
}

/**
 * Mirrors the name Keycloak just accepted into the core shadow
 * (`PATCH /v1/users/me`) with the same user token, retrying exactly once with
 * a force-refreshed token when core rejects the bearer. A failure never undoes
 * the Keycloak change: it is reported as `failed` and logged as
 * `identity_name_core_sync_failed` so the shadow can be reconciled later.
 */
async function syncCoreName(
  services: Services,
  session: Session,
  accessToken: string,
  name: { firstName: string; lastName: string },
  requestId: string,
): Promise<NameChangePayload["coreSync"]> {
  const core = services.coreProfile;
  if (!core) {
    logAuthEvent({ event: "identity_name_core_sync_failed", requestId, outcome: "failure", reason: "core_disabled" });
    return "disabled";
  }
  try {
    try {
      await core.patchMe(accessToken, name);
    } catch (error) {
      if (!(error instanceof CoreProfileUnauthorizedError)) throw error;
      await core.patchMe(await services.account.accessToken(session, { forceRefresh: true }), name);
    }
    return "synced";
  } catch (error) {
    logAuthEvent({
      event: "identity_name_core_sync_failed",
      requestId,
      outcome: "failure",
      reason: coreSyncFailureReason(error),
    });
    return "failed";
  }
}

/** `GET /api/account/identity`: the identity view and the CSRF proof. */
export async function identityRoute(request: NextRequest) {
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
    const accessToken = await services.account.accessToken(session);
    const identity = await services.skyAccount.identity({ accessToken });
    const payload: IdentityPayload = {
      ...identityView(identity),
      csrfToken: services.sessions.csrfToken(session.id),
    };
    return noStore(NextResponse.json(payload));
  } catch (error) {
    return failureResponse(request, services, session, error);
  }
}

/**
 * `PATCH /api/account/identity/name`: `{ firstName, lastName }` → sky-account
 * `PATCH identity/name` (no Sudo mode; a Verified YTÜ account is refused
 * with `403 name_locked` by the SPI), then core `PATCH /v1/users/me` with
 * the same names. `200 { coreSync }`.
 */
export function changeNameRoute(request: NextRequest) {
  return identityMutation(request, "name", async (services, session, auth) => {
    const body = await readJsonBody(request);
    const name = { firstName: requirePersonName(body, "firstName"), lastName: requirePersonName(body, "lastName") };
    const identity = await services.skyAccount.patchName({ accessToken: auth.accessToken }, name);
    const accepted = { firstName: identity.firstName ?? name.firstName, lastName: identity.lastName ?? name.lastName };
    const coreSync = await syncCoreName(services, session, auth.accessToken, accepted, requestCorrelationId(request));
    const payload: NameChangePayload = { coreSync };
    return noStore(NextResponse.json(payload));
  });
}

/**
 * `POST /api/account/identity/username`: `{ username }` → Sudo mode gate →
 * sky-account `POST identity/username` with `X-Sky-Sudo`. `204`; the page
 * re-reads `GET /api/account/identity` for the new username.
 */
export function changeUsernameRoute(request: NextRequest) {
  return identityMutation(request, "username", async (services, _session, auth) => {
    const body = await readJsonBody(request);
    const username = requireUsername(body);
    await services.skyAccount.changeUsername(auth, { username });
    return noStore(new NextResponse(null, { status: 204 }));
  });
}
