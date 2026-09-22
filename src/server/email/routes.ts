import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import { noStore, SESSION_COOKIE } from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { getAuthServices } from "@/server/auth/services";
import { requireAccountSpiSudo } from "@/server/auth/sudo-gate";
import type { BrowserSession } from "@/server/auth/types";
import { emailView } from "@/server/email/view";
import type { EmailPayload } from "@/server/email/view";
import {
  authenticateMutation,
  failureResponse as accountFailureResponse,
  finish,
  identityRouteCopy,
  isReauthenticationRequired,
  readJsonBody,
} from "@/server/identity/routes";
import { SkyAccountProblem, SkyAccountUnavailableError } from "@/server/sky-account/client";
import type { PrimaryEmailInput } from "@/server/sky-account/client";

type Services = ReturnType<typeof getAuthServices>;
type Session = BrowserSession["session"];
type AddressAction = NonNullable<Parameters<typeof logAuthEvent>[0]["addressAction"]>;
type FailureReason = NonNullable<Parameters<typeof logAuthEvent>[0]["reason"]>;
type PrimaryChoice = PrimaryEmailInput["which"];

/** RFC 5321 path limit; only obvious non-addresses stop here, Keycloak's own validator decides the rest. */
const MAX_ADDRESS_LENGTH = 254;
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+$/;
const EMAIL_CODE = /^\d{6}$/;

/**
 * Body of the e-mail routes' own non-2xx answers; everything else (session,
 * Sudo mode `428`, lockouts, rate limits, outages, contract drift) is
 * answered exactly like the identity routes. `field` names the rejected
 * input, `attemptsLeft` accompanies a wrong code (`0`: the code is dead and a
 * new one must be requested). No address or code ever appears in an answer
 * or a log line.
 */
export type EmailRouteProblem = {
  error:
    | "invalid_request"
    | "invalid_address"
    | "invalid_code"
    | "no_pending_change"
    | "email_taken"
    | "email_not_verified"
    | "no_fallback_email"
    | "email_not_sent"
    | "rate_limited";
  detail: string;
  field?: "address" | "code" | "which";
  attemptsLeft?: number;
  retryAfter?: number;
};

/** `202` answer of `POST …/email/change-request`: when the mailed code stops working. */
export type EmailChangePayload = { expiresAt: string };

export const emailRouteCopy = {
  invalidAddress: "Geçerli bir e-posta adresi gir.",
  refusedAddress: "Bu adres kullanılamıyor: geçerli bir e-posta adresi değil ya da zaten hesabında kayıtlı.",
  invalidCode: "Doğrulama kodu 6 rakamdan oluşur.",
  invalidChoice: "Birincil adres için okul ya da kişisel e-postanı seç.",
  schoolNotVerified: "Okul e-postan, YTÜ hesabın bağlanmadan birincil adres yapılamaz. YTÜ hesabını Kimlik sayfasından bağlayabilirsin.",
  personalNotVerified: "Kişisel e-postan doğrulanmadığı için birincil adres yapılamaz. Adresi kaldırıp yeniden ekle ve gelen kodla doğrula.",
  noFallback: "Kişisel e-postan birincil adresin ve yerine geçebilecek doğrulanmış bir okul e-postan yok; kaldırırsan giriş yapabileceğin bir adres kalmaz. Önce YTÜ hesabını bağla ve okul e-postanı birincil yap.",
} as const;
const copy = emailRouteCopy;

/** An input refused before anything was sent upstream. */
class EmailFieldError extends Error {
  constructor(
    readonly field: "address" | "code" | "which",
    readonly detail: string,
  ) {
    super(`The e-mail field ${field} is invalid.`);
    this.name = "EmailFieldError";
  }
}

/**
 * `409 email_not_verified` from `email/primary`, tied to the address the
 * person chose: the SPI's sentence still speaks of a link, and the two cases
 * (a school address without the YTÜ link, a personal one without its code)
 * need different advice.
 */
class UnprovenAddressError extends Error {
  constructor(readonly which: PrimaryChoice) {
    super("The chosen primary address is not proven.");
    this.name = "UnprovenAddressError";
  }
}

function problemResponse(status: number, problem: EmailRouteProblem, headers: Record<string, string> = {}) {
  return noStore(NextResponse.json(problem, { status, headers }));
}

/**
 * Maps a failure to the browser answer: the e-mail problems first, then the
 * identity routes' mapping for everything they share (an ended session, a
 * proof the SPI rejects, malformed bodies, lockouts, rate limits, outages,
 * drift).
 */
function failureResponse(request: NextRequest, services: Services, session: Session, error: unknown) {
  if (error instanceof EmailFieldError) {
    return problemResponse(400, {
      error: error.field === "address" ? "invalid_address" : "invalid_request",
      detail: error.detail,
      field: error.field,
    });
  }
  if (error instanceof UnprovenAddressError) {
    return problemResponse(409, {
      error: "email_not_verified",
      detail: error.which === "school" ? copy.schoolNotVerified : copy.personalNotVerified,
    });
  }
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "invalid_email_code":
        return problemResponse(400, {
          error: "invalid_code",
          detail: error.detail,
          ...(error.attemptsLeft !== null ? { attemptsLeft: error.attemptsLeft } : {}),
        });
      case "no_pending_email_change":
        return problemResponse(404, { error: "no_pending_change", detail: error.detail });
      case "email_taken":
        return problemResponse(409, { error: "email_taken", detail: error.detail, field: "address" });
      case "no_fallback_email":
        // The SPI's sentence names only a missing school address; an unlinked one blocks too.
        return problemResponse(409, { error: "no_fallback_email", detail: copy.noFallback });
      case "email_not_sent":
        return problemResponse(503, { error: "email_not_sent", detail: error.detail }, { "Retry-After": "60" });
      case "invalid_request":
        if (error.field === "address") {
          return problemResponse(400, { error: "invalid_address", detail: copy.refusedAddress, field: "address" });
        }
        break;
      default:
        break;
    }
  }
  return accountFailureResponse(request, services, session, error);
}

function failureReason(error: unknown): FailureReason {
  if (isReauthenticationRequired(error)) return "invalid_token";
  if (error instanceof EmailFieldError) return error.field === "address" ? "invalid_address" : "contract_blocked";
  if (error instanceof UnprovenAddressError) return "email_not_verified";
  if (error instanceof SkyAccountProblem) {
    switch (error.code) {
      case "sudo_required":
      case "sudo_expired":
        return "sudo_rejected_upstream";
      case "invalid_email_code":
        return error.attemptsLeft === 0 ? "code_exhausted" : "invalid_code";
      case "no_pending_email_change":
        return "no_pending_change";
      case "email_taken":
        return "email_taken";
      case "email_not_verified":
        return "email_not_verified";
      case "no_fallback_email":
        return "no_fallback_email";
      case "email_not_sent":
        return "email_not_sent";
      case "invalid_request":
        return error.field === "address" ? "invalid_address" : "contract_blocked";
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

function requireAddress(value: unknown) {
  const address = typeof value === "string" ? value.trim() : "";
  if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS_SHAPE.test(address)) {
    throw new EmailFieldError("address", copy.invalidAddress);
  }
  return address;
}

/** Six digits; the spaces a copy from the mail inserts are dropped. Anything else never reaches the SPI, so it costs no attempt. */
function requireCode(value: unknown) {
  const code = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!EMAIL_CODE.test(code)) throw new EmailFieldError("code", copy.invalidCode);
  return code;
}

function requireChoice(value: unknown): PrimaryChoice {
  const which = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (which !== "school" && which !== "personal") throw new EmailFieldError("which", copy.invalidChoice);
  return which;
}

type BearerAuth = { accessToken: string };
type SudoAuth = BearerAuth & { sudoToken: string };
type Operate<Auth extends BearerAuth> = (services: Services, auth: Auth) => Promise<NextResponse>;

/**
 * Runs one e-mail mutation: exact origin, session CSRF, access gate and
 * session first; then, for every action except the code confirmation, the
 * Sudo mode gate (`428` when no proof with SPI material is fresh); then the
 * local budget (`email_confirm` for codes, `email_mutation` otherwise); only
 * then the body is read and the SPI called. Every answer carries a rotated
 * handle when one was issued. Logs name the action and a fixed reason only.
 */
function emailMutation(request: NextRequest, action: "confirm", operate: Operate<BearerAuth>): Promise<NextResponse>;
function emailMutation(
  request: NextRequest,
  action: Exclude<AddressAction, "confirm">,
  operate: Operate<SudoAuth>,
): Promise<NextResponse>;
async function emailMutation(
  request: NextRequest,
  action: AddressAction,
  operate: Operate<BearerAuth> | Operate<SudoAuth>,
): Promise<NextResponse> {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const log = (outcome: "success" | "failure", reason?: FailureReason) => logAuthEvent({
    event: "email_action",
    requestId,
    outcome,
    ...(reason ? { reason } : {}),
    addressAction: action,
  });
  const authorization = await authenticateMutation(request, services);
  if (!authorization.ok) return authorization.response;
  const session = authorization.value.session;
  try {
    let sudo: Pick<SudoAuth, "sudoToken"> | null = null;
    if (action !== "confirm") {
      const gate = await requireAccountSpiSudo(services, session, { requestId });
      if (!gate.ok) {
        log("failure", gate.reason === "spi_token_required" ? "spi_token_required" : "sudo_required");
        return finish(gate.response, authorization.value);
      }
      sudo = { sudoToken: gate.proof.sudoToken };
    }
    const limit = await services.anonymousRateLimit.consumeKey(
      action === "confirm" ? "email_confirm" : "email_mutation",
      session.id,
    );
    if (!limit.allowed) {
      log("failure", "rate_limited");
      return finish(problemResponse(429, {
        error: "rate_limited",
        detail: identityRouteCopy.tooManyAttempts,
        retryAfter: limit.retryAfterSeconds,
      }, { "Retry-After": String(limit.retryAfterSeconds) }), authorization.value);
    }
    const accessToken = await services.account.accessToken(session);
    // The overloads guarantee a sudo-carrying `operate` only for the actions the gate above served.
    const response = await (operate as Operate<BearerAuth>)(services, { accessToken, ...sudo });
    log("success");
    return finish(response, authorization.value);
  } catch (error) {
    log("failure", failureReason(error));
    return finish(
      await failureResponse(request, services, session, error),
      authorization.value,
      isReauthenticationRequired(error),
    );
  }
}

/** `GET /api/account/email`: both addresses, the primary and the CSRF proof. */
export async function emailRoute(request: NextRequest) {
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
    const payload: EmailPayload = {
      ...emailView(identity),
      csrfToken: services.sessions.csrfToken(session.id),
    };
    return noStore(NextResponse.json(payload));
  } catch (error) {
    return failureResponse(request, services, session, error);
  }
}

/**
 * `POST /api/account/email/change-request`: `{ address }` → Sudo mode gate →
 * sky-account `POST email/change-request`. `202 { expiresAt }`: the code is
 * in the mail and the page asks for it; nothing about the person changed yet.
 * A second request replaces the first (its code dies); the SPI mails at most
 * three codes an hour.
 */
export function requestEmailChangeRoute(request: NextRequest) {
  return emailMutation(request, "change_request", async (services, auth) => {
    const body = await readJsonBody(request);
    const address = requireAddress(body.address);
    const change = await services.skyAccount.requestEmailChange(auth, { address });
    const payload: EmailChangePayload = { expiresAt: change.expiresAt.toISOString() };
    return noStore(NextResponse.json(payload, { status: 202 }));
  });
}

/**
 * `POST /api/account/email/confirm`: `{ code }` → sky-account
 * `POST email/confirm` with the session's bearer only (no Sudo mode: the
 * code proves the address and the SPI matches it only against this person's
 * own pending change). `204`; the page re-reads `GET /api/account/email`.
 */
export function confirmEmailRoute(request: NextRequest) {
  return emailMutation(request, "confirm", async (services, auth) => {
    const body = await readJsonBody(request);
    const code = requireCode(body.code);
    await services.skyAccount.confirmEmail(auth, { code });
    return noStore(new NextResponse(null, { status: 204 }));
  });
}

/** `POST /api/account/email/primary`: `{ which: "school" | "personal" }` → Sudo mode gate → `POST email/primary`. `204`. */
export function setPrimaryEmailRoute(request: NextRequest) {
  return emailMutation(request, "primary", async (services, auth) => {
    const body = await readJsonBody(request);
    const which = requireChoice(body.which);
    try {
      await services.skyAccount.setPrimaryEmail(auth, { which });
    } catch (error) {
      if (error instanceof SkyAccountProblem && error.code === "email_not_verified") throw new UnprovenAddressError(which);
      throw error;
    }
    return noStore(new NextResponse(null, { status: 204 }));
  });
}

/**
 * `DELETE /api/account/email/personal` → Sudo mode gate →
 * `DELETE email/personal`. `204`. A primary personal address is kept
 * (`409 no_fallback_email`) when no proven school address can take over.
 */
export function removePersonalEmailRoute(request: NextRequest) {
  return emailMutation(request, "remove", async (services, auth) => {
    await services.skyAccount.removePersonalEmail(auth);
    return noStore(new NextResponse(null, { status: 204 }));
  });
}
