import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import { constantTimeEqual } from "@/server/auth/crypto";
import {
  noStore,
  SESSION_COOKIE,
  sessionMutationHasExactOrigin,
  setSessionCookie,
} from "@/server/auth/http";
import { validCredentialLabel } from "@/lib/labels";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import type { AnonymousAuthRateLimitScope } from "@/server/auth/rate-limit";
import { readUtf8Body, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import { requireAccountSpiSudo, sudoRequiredResponse } from "@/server/auth/sudo-gate";
import type { SudoSpiProof } from "@/server/auth/sudo-gate";
import { resolveSudoMethods } from "@/server/auth/sudo-methods";
import type { BrowserSession } from "@/server/auth/types";
import {
  AccountAccessTokenContractError,
  AccountAccessTokenExpiredError,
} from "@/server/keycloak-account/access-token";
import { KeycloakAccountUnauthorizedError } from "@/server/keycloak-account/adapter";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { securityView } from "@/server/security/view";
import type { SecurityCredentialView, SecurityPayload } from "@/server/security/view";
import {
  parseWebauthnAttestation,
  SkyAccountContractError,
  SkyAccountInvalidInputError,
  SkyAccountProblem,
  SkyAccountUnavailableError,
} from "@/server/sky-account/client";
import type { SkyAccountCredential, SkyAccountIdentity } from "@/server/sky-account/client";

type Services = ReturnType<typeof getAuthServices>;
type Session = BrowserSession["session"];
type SecurityAction = NonNullable<Parameters<typeof logAuthEvent>[0]["securityAction"]>;
type FailureReason = NonNullable<Parameters<typeof logAuthEvent>[0]["reason"]>;

const JSON_CONTENT_TYPE = "application/json";
/** `{ newPassword, logoutOtherSessions }` and `{ setupHandle, code, label }` bodies. */
const MAX_SMALL_BODY_BYTES = 4 * 1_024;
/** A passkey attestation may carry up to 64 KB (contract, Uç noktalar). */
const MAX_ATTESTATION_BODY_BYTES = 64 * 1_024;
const MAX_PASSWORD_LENGTH = 1_024;
const TOTP_CODE = /^\d{4,10}$/;
const SETUP_HANDLE = /^[A-Za-z0-9_-]{1,255}$/;
const CREDENTIAL_REFERENCE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Body of every non-2xx answer of the security routes (except the `428`
 * sudo challenge and the session answers): a stable `error` key the page
 * branches on and a Turkish `detail` it may show. `policy`/`params`
 * accompany `password_policy`, `retryAfter` (seconds) accompanies rate
 * limits and lockouts. Passwords, codes, secrets, attestations, credential
 * ids and tokens never appear in any answer.
 */
export type SecurityRouteProblem = {
  error:
    | "invalid_request"
    | "password_policy"
    | "password_rejected"
    | "invalid_code"
    | "setup_expired"
    | "duplicate_label"
    | "passkey_already_registered"
    | "webauthn_invalid"
    | "webauthn_origin_not_allowed"
    | "challenge_expired"
    | "credential_not_found"
    | "locked"
    | "disabled"
    | "rate_limited"
    | "unavailable"
    | "upstream_error"
    | "unexpected";
  detail: string;
  retryAfter?: number;
  policy?: string;
  params?: Array<string | number>;
};

/** `POST …/totp/setup` answer: the SPI's setup relayed unchanged (the secret is shown once and never stored here). */
export type TotpSetupPayload = {
  setupHandle: string;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
  policy: { type: "totp"; algorithm: "SHA1" | "SHA256" | "SHA512"; digits: 6 | 8; period: number };
};

/** `201` answer of `…/totp/confirm` and `…/passkeys/register`: the new row as the list shows it. */
export type CredentialCreatedPayload = { credential: SecurityCredentialView };

const copy = {
  invalidRequest: "İstek anlaşılamadı. Sayfayı yenileyip yeniden dene.",
  unavailable: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden dene.",
  contract: "Kimlik hizmetinin yanıtı desteklenen sürümle eşleşmedi. Değişiklik yapılmadı.",
  unexpected: "Beklenmeyen bir sorun oluştu. Değişiklik yapılmadı.",
  tooManyAttempts: "Çok fazla deneme yaptın. Biraz sonra yeniden dene.",
  credentialNotFound: "Kimlik bilgisi bulunamadı. Listeyi yenileyip yeniden dene.",
} as const;

class SecurityRequestError extends Error {
  constructor(readonly status: 400 | 413) {
    super("Invalid security request body.");
    this.name = "SecurityRequestError";
  }
}

class CredentialReferenceError extends Error {
  constructor() {
    super("The credential reference does not name a credential of this session's person.");
    this.name = "CredentialReferenceError";
  }
}

function problemResponse(
  status: number,
  problem: SecurityRouteProblem,
  headers: Record<string, string> = {},
) {
  return noStore(NextResponse.json(problem, { status, headers }));
}

function forbiddenResponse() {
  return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
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
function finish(response: NextResponse, authorization: BrowserSession, sessionEnded = false) {
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

/**
 * Maps a failure to the browser answer. Rejections of the person's own bearer
 * end the local session like the other account routes do; a proof the SPI
 * rejects is discarded locally and answered with the same `428` challenge
 * the gate sends, so the page reopens the dialog instead of retrying blindly.
 */
async function failureResponse(
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
  if (error instanceof SecurityRequestError) {
    return problemResponse(error.status, { error: "invalid_request", detail: copy.invalidRequest });
  }
  if (error instanceof SkyAccountInvalidInputError) {
    return problemResponse(400, { error: "invalid_request", detail: copy.invalidRequest });
  }
  if (error instanceof CredentialReferenceError) {
    return problemResponse(404, { error: "credential_not_found", detail: copy.credentialNotFound });
  }
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "password_policy":
        return problemResponse(400, {
          error: "password_policy",
          detail: error.detail,
          ...(error.policy !== null ? { policy: error.policy } : {}),
          params: [...error.params],
        });
      case "password_rejected":
        return problemResponse(400, { error: "password_rejected", detail: error.detail });
      case "invalid_totp_code":
        return problemResponse(400, { error: "invalid_code", detail: error.detail });
      case "totp_setup_expired":
        return problemResponse(400, { error: "setup_expired", detail: error.detail });
      case "duplicate_label":
        return problemResponse(409, { error: "duplicate_label", detail: error.detail });
      case "passkey_already_registered":
        return problemResponse(409, { error: "passkey_already_registered", detail: error.detail });
      case "webauthn_invalid":
        return problemResponse(400, { error: "webauthn_invalid", detail: error.detail });
      case "webauthn_origin_not_allowed":
        return problemResponse(400, { error: "webauthn_origin_not_allowed", detail: error.detail });
      case "webauthn_challenge_expired":
        return problemResponse(400, { error: "challenge_expired", detail: error.detail });
      case "credential_not_found":
        return problemResponse(404, { error: "credential_not_found", detail: error.detail });
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
  if (error instanceof SkyAccountContractError || error instanceof AccountAccessTokenContractError) {
    return problemResponse(502, { error: "upstream_error", detail: copy.contract });
  }
  return problemResponse(500, { error: "unexpected", detail: copy.unexpected });
}

function failureReason(error: unknown): FailureReason {
  if (isReauthenticationRequired(error)) return "invalid_token";
  if (isSudoRejectedUpstream(error)) return "sudo_rejected_upstream";
  if (error instanceof CredentialReferenceError) return "credential_not_found";
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "password_policy":
      case "password_rejected":
        return "policy_rejected";
      case "invalid_totp_code":
        return "invalid_code";
      case "totp_setup_expired":
        return "setup_expired";
      case "duplicate_label":
        return "duplicate_label";
      case "passkey_already_registered":
        return "already_registered";
      case "webauthn_invalid":
      case "webauthn_origin_not_allowed":
      case "webauthn_challenge_expired":
        return "webauthn_rejected";
      case "credential_not_found":
        return "credential_not_found";
      case "rate_limited":
        return "rate_limited";
      case "user_temporarily_locked":
      case "user_disabled":
        return "user_locked";
      case "webauthn_not_configured":
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

async function authenticateMutation(request: NextRequest, services: Services): Promise<MutationAuthorization> {
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
    throw new SecurityRequestError(error instanceof RequestBodyError ? error.status : 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SecurityRequestError(400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SecurityRequestError(400);
  return value as Record<string, unknown>;
}

async function rateLimited(
  services: Services,
  scope: Extract<AnonymousAuthRateLimitScope, "security_mutation" | "totp_confirm">,
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

function rowOf(services: Services, session: Session, credential: SkyAccountCredential): SecurityCredentialView {
  return {
    reference: services.sessions.credentialReference(session.id, credential.id),
    label: credential.label,
    createdAt: credential.createdAt,
    ...(credential.transports ? { transports: [...credential.transports] } : {}),
    ...(credential.type === "webauthn" ? { legacy: true as const } : {}),
  };
}

function requirePassword(body: Record<string, unknown>) {
  const password = body.newPassword;
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw new SecurityRequestError(400);
  }
  return password;
}

function requireBoolean(value: unknown) {
  if (typeof value !== "boolean") throw new SecurityRequestError(400);
  return value;
}

function requireCode(value: unknown) {
  const code = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!TOTP_CODE.test(code)) throw new SecurityRequestError(400);
  return code;
}

/** Normalised like the SPI does (format characters dropped, spaces collapsed); empty or over-long labels are refused here. */
function requireLabel(value: unknown) {
  const label = validCredentialLabel(value);
  if (label === null) throw new SecurityRequestError(400);
  return label;
}

function requireSetupHandle(value: unknown) {
  if (typeof value !== "string" || !SETUP_HANDLE.test(value)) throw new SecurityRequestError(400);
  return value;
}

/**
 * Runs one sudo-protected security mutation: exact origin, session CSRF,
 * access gate and session first; then the Sudo mode gate (`428` when no
 * proof with SPI material is fresh); then the local budget; only then the
 * body is read and the SPI called with `X-Sky-Sudo`. Every answer carries a
 * rotated handle when one was issued.
 */
async function securityMutation(
  request: NextRequest,
  action: SecurityAction,
  scope: "security_mutation" | "totp_confirm",
  operate: (
    services: Services,
    session: Session,
    auth: { accessToken: string; sudoToken: string },
    proof: SudoSpiProof,
  ) => Promise<NextResponse>,
) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const authorization = await authenticateMutation(request, services);
  if (!authorization.ok) return authorization.response;
  const session = authorization.value.session;
  try {
    const gate = await requireAccountSpiSudo(services, session, { requestId });
    if (!gate.ok) {
      logAuthEvent({
        event: "security_action",
        requestId,
        outcome: "failure",
        reason: gate.reason === "spi_token_required" ? "spi_token_required" : "sudo_required",
        securityAction: action,
      });
      return finish(gate.response, authorization.value);
    }
    const limited = await rateLimited(services, scope, session.id);
    if (limited) {
      logAuthEvent({ event: "security_action", requestId, outcome: "failure", reason: "rate_limited", securityAction: action });
      return finish(limited, authorization.value);
    }
    const accessToken = await services.account.accessToken(session);
    const response = await operate(services, session, { accessToken, sudoToken: gate.proof.sudoToken }, gate.proof);
    logAuthEvent({ event: "security_action", requestId, outcome: "success", securityAction: action });
    return finish(response, authorization.value);
  } catch (error) {
    logAuthEvent({
      event: "security_action",
      requestId,
      outcome: "failure",
      reason: failureReason(error),
      securityAction: action,
    });
    return finish(
      await failureResponse(request, services, session, error),
      authorization.value,
      isReauthenticationRequired(error),
    );
  }
}

/** `GET /api/account/security`: the credential inventory, Sudo mode state and the CSRF proof. */
export async function securityRoute(request: NextRequest) {
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
    const [identity, active] = await Promise.all([
      services.skyAccount.identity({ accessToken }),
      services.sudo.currentSudo(session.id, { requestId }),
    ]);
    const payload: SecurityPayload = {
      ...securityView(identity, session, (sessionId, credentialId) =>
        services.sessions.credentialReference(sessionId, credentialId), active),
      csrfToken: services.sessions.csrfToken(session.id),
    };
    return noStore(NextResponse.json(payload));
  } catch (error) {
    return failureResponse(request, services, session, error);
  }
}

/** `POST /api/account/security/password`: `{ newPassword, logoutOtherSessions }` → sky-account `credentials/password`, `204`. */
export function changePasswordRoute(request: NextRequest) {
  return securityMutation(request, "password", "security_mutation", async (services, _session, auth) => {
    const body = await readJsonBody(request, MAX_SMALL_BODY_BYTES);
    const newPassword = requirePassword(body);
    const logoutOtherSessions = requireBoolean(body.logoutOtherSessions);
    await services.skyAccount.changePassword(auth, { newPassword, logoutOtherSessions });
    return noStore(new NextResponse(null, { status: 204 }));
  });
}

/** `POST /api/account/security/totp/setup`: sky-account `credentials/totp/setup` relayed (secret shown once). */
export function totpSetupRoute(request: NextRequest) {
  return securityMutation(request, "totp_setup", "security_mutation", async (services, _session, auth) => {
    const setup = await services.skyAccount.totpSetup(auth);
    const payload: TotpSetupPayload = {
      setupHandle: setup.setupHandle,
      secret: setup.secret,
      otpauthUri: setup.otpauthUri,
      expiresAt: setup.expiresAt.toISOString(),
      policy: setup.policy,
    };
    return noStore(NextResponse.json(payload));
  });
}

/** `POST /api/account/security/totp/confirm`: `{ setupHandle, code, label }` → sky-account `credentials/totp/confirm`, `201`. */
export function totpConfirmRoute(request: NextRequest) {
  return securityMutation(request, "totp_confirm", "totp_confirm", async (services, session, auth) => {
    const body = await readJsonBody(request, MAX_SMALL_BODY_BYTES);
    const setupHandle = requireSetupHandle(body.setupHandle);
    const code = requireCode(body.code);
    const label = requireLabel(body.label);
    const credential = await services.skyAccount.totpConfirm(auth, { setupHandle, code, label });
    const payload: CredentialCreatedPayload = { credential: rowOf(services, session, credential) };
    return noStore(NextResponse.json(payload, { status: 201 }));
  });
}

/** `POST /api/account/security/passkeys/options`: creation options for `navigator.credentials.create()`. */
export function passkeyOptionsRoute(request: NextRequest) {
  return securityMutation(request, "passkey_options", "security_mutation", async (services, _session, auth) => {
    const options = await services.skyAccount.webauthnRegistrationOptions(auth);
    return noStore(NextResponse.json(options));
  });
}

/** `POST /api/account/security/passkeys/register`: `{ attestation, label }` → sky-account `credentials/webauthn/register`, `201`. */
export function passkeyRegisterRoute(request: NextRequest) {
  return securityMutation(request, "passkey_register", "security_mutation", async (services, session, auth) => {
    const body = await readJsonBody(request, MAX_ATTESTATION_BODY_BYTES);
    const attestation = parseWebauthnAttestation(body.attestation);
    if (!attestation) throw new SecurityRequestError(400);
    const label = requireLabel(body.label);
    const credential = await services.skyAccount.registerPasskey(auth, { attestation, label });
    const payload: CredentialCreatedPayload = { credential: rowOf(services, session, credential) };
    return noStore(NextResponse.json(payload, { status: 201 }));
  });
}

/** Finds the credential a session-bound reference names in a fresh identity read; `null` when nothing matches. */
export function resolveCredentialReference(
  identity: SkyAccountIdentity,
  session: { id: string },
  reference: string,
  referenceOf: (sessionId: string, credentialId: string) => string,
): SkyAccountCredential | null {
  if (!CREDENTIAL_REFERENCE.test(reference)) return null;
  const owned = [...identity.credentials.totp, ...identity.credentials.passkeys];
  return owned.find((credential) => constantTimeEqual(referenceOf(session.id, credential.id), reference)) ?? null;
}

/**
 * `DELETE /api/account/security/credentials/{reference}`: resolves the opaque,
 * session-bound reference against a fresh `GET identity` and only then calls
 * sky-account `DELETE credentials/{id}`. `204`; an unknown or foreign
 * reference is `404 credential_not_found` before any SPI mutation.
 */
export function deleteCredentialRoute(request: NextRequest, reference: string) {
  return securityMutation(request, "credential_delete", "security_mutation", async (services, session, auth) => {
    const identity = await services.skyAccount.identity({ accessToken: auth.accessToken });
    const credential = resolveCredentialReference(identity, session, reference, (sessionId, credentialId) =>
      services.sessions.credentialReference(sessionId, credentialId));
    if (!credential) throw new CredentialReferenceError();
    await services.skyAccount.deleteCredential(auth, credential.id);
    return noStore(new NextResponse(null, { status: 204 }));
  });
}
