import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import {
  clearSessionCookie,
  noStore,
  SESSION_COOKIE,
  sessionMutationHasExactOrigin,
  setSessionCookie,
} from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { readBytesBody, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import { clubProfileServiceFor } from "@/server/club-profile/service";
import { CoreConsentError } from "@/server/core/consents-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import {
  offersSignupBox,
  parseGrantBody,
  promotionalConsentServiceFor,
  PromotionalConsentInputError,
} from "@/server/promotional-consent/service";
import type { PromotionalConsentService } from "@/server/promotional-consent/service";

/**
 * Browser BFF routes for the promotional consent ("Tanıtım içerikleri",
 * core `docs/contact-consents.md`). Writing needs the exact configured origin
 * and the session-bound CSRF proof, like the communication preferences, and
 * no Sudo mode. The purpose and the text version are the BFF's, never the
 * browser's: `POST` takes only where the box was ticked.
 */

const POST_BODY_MAX_BYTES = 1_024;
const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

export type PromotionalConsentProblem = AccountProblem & { code?: string; retryAfterSeconds?: number };

/** `CORE_API_URL` is unset, or core records no consents (`CONTACT_CONSENT_KEY` unset): the box is not shown. */
export const promotionalConsentOffProblem: PromotionalConsentProblem = {
  type: `${PROBLEM_BASE}promotional-consent-unavailable`,
  title: "Tanıtım izni şu an kullanılamıyor",
  status: 503,
  detail: "Tanıtım izni bu ortamda kapalı; hiçbir şey kaydedilmedi.",
  code: "consents_unavailable",
};

export function toPromotionalConsentProblem(error: unknown): PromotionalConsentProblem {
  if (error instanceof PromotionalConsentInputError || error instanceof RequestBodyError) {
    return {
      type: `${PROBLEM_BASE}promotional-consent-invalid`,
      title: "İstek okunamadı",
      status: 400,
      detail: "Sayfayı yenileyip yeniden dene; iznin değişmedi.",
    };
  }
  if (!(error instanceof CoreConsentError)) return toAccountProblem(error);
  switch (error.failure) {
    case "off":
      return promotionalConsentOffProblem;
    case "addresses_unavailable":
      return {
        type: `${PROBLEM_BASE}promotional-consent-addresses-unavailable`,
        title: "E-posta adreslerin şu an okunamadı",
        status: 503,
        detail: "Biraz sonra yeniden dene.",
        code: "consent_addresses_unavailable",
        ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    case "unauthorized":
      return {
        type: `${PROBLEM_BASE}promotional-consent-reauthentication`,
        title: "Yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Oturumunun core erişimi doğrulanamadı; iznin değişmedi.",
      };
    case "forbidden":
      return {
        type: `${PROBLEM_BASE}promotional-consent-forbidden`,
        title: "Tanıtım izni bu hesap için kullanılamıyor",
        status: 403,
        detail: "Core bu hesap için izin yazmadı.",
      };
    case "contract":
      return {
        type: `${PROBLEM_BASE}promotional-consent-contract`,
        title: "Tanıtım izni güvenle durduruldu",
        status: 502,
        detail: "Core yanıtı beklenen biçimde değildi. Sayfayı yenileyip yeniden dene.",
      };
    case "rejected":
    case "invalid_input":
      return {
        type: `${PROBLEM_BASE}promotional-consent-rejected`,
        title: "Core isteği kabul etmedi",
        status: 400,
        detail: "Sayfayı yenileyip yeniden dene; iznin değişmedi.",
      };
    case "unavailable":
      return {
        type: `${PROBLEM_BASE}promotional-consent-core-unavailable`,
        title: "Tanıtım iznine şu anda ulaşılamıyor",
        status: 503,
        detail: "Core yanıt vermedi; iznin değişmedi. Biraz sonra yeniden dene.",
      };
  }
}

type Services = ReturnType<typeof getAuthServices>;
type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: PromotionalConsentProblem) {
  const response = noStore(NextResponse.json(
    { ...problem, instance: request.nextUrl.pathname },
    { status: problem.status, headers: { "content-type": "application/problem+json" } },
  ));
  if (problem.retryAfterSeconds !== undefined) response.headers.set("Retry-After", String(problem.retryAfterSeconds));
  return response;
}

function withRotatedHandle(response: NextResponse, sessionUse: SessionUse) {
  if (sessionUse.rotatedHandle) setSessionCookie(response, sessionUse.rotatedHandle, sessionUse.session.absoluteExpiresAt);
  return response;
}

/** A Keycloak-side 401 ends the local session like every account route; a core 401 only reports it. */
async function failureResponse(request: NextRequest, services: Services, sessionUse: SessionUse, error: unknown) {
  const response = problemResponse(request, toPromotionalConsentProblem(error));
  if (response.status === 401 && !(error instanceof CoreConsentError)) {
    try {
      await services.sessions.revokeSession(sessionUse.session.id);
    } catch {
      logAuthEvent({
        event: "account_session_cleanup",
        requestId: requestCorrelationId(request),
        outcome: "failure",
        reason: "local_session_revocation_failed",
      });
    } finally {
      clearSessionCookie(response);
    }
    return response;
  }
  return withRotatedHandle(response, sessionUse);
}

type Authenticated =
  | { ok: true; services: Services; consent: PromotionalConsentService; sessionUse: SessionUse }
  | { ok: false; response: NextResponse };

async function authenticateMutation(request: NextRequest): Promise<Authenticated> {
  const services = getAuthServices();
  if (!sessionMutationHasExactOrigin(request, services.config)) {
    return { ok: false, response: noStore(NextResponse.json({ error: "forbidden" }, { status: 403 })) };
  }
  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true },
  );
  if (authorization.status === "forbidden") {
    return { ok: false, response: noStore(NextResponse.json({ error: "forbidden" }, { status: 403 })) };
  }
  if (authorization.status === "unavailable") return { ok: false, response: accountAccessUnavailableResponse() };
  if (authorization.status === "blocked") return { ok: false, response: authenticationRequiredResponse(true) };
  if (authorization.status !== "active") return { ok: false, response: authenticationRequiredResponse() };
  const consent = promotionalConsentServiceFor(services);
  if (!consent) {
    return { ok: false, response: withRotatedHandle(problemResponse(request, promotionalConsentOffProblem), authorization.value) };
  }
  return { ok: true, services, consent, sessionUse: authorization.value };
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const bytes = await readBytesBody(request, {
    maxBytes: POST_BODY_MAX_BYTES,
    contentType: (value) => value === "application/json",
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PromotionalConsentInputError();
  }
}

/** `POST /api/account/promotional-consent` `{"source": "self"|"signup"}` → `{ promotional: "active" }`. */
export async function grantPromotionalConsent(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, consent, sessionUse } = access;
  try {
    const source = parseGrantBody(await readJsonBody(request));
    const promotional = await consent.grant(sessionUse.session, source);
    return withRotatedHandle(noStore(NextResponse.json({ promotional })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

/**
 * `DELETE /api/account/promotional-consent` → `{ promotional: "none" }`: ends
 * every open grant that mails one of the person's addresses. While Keycloak
 * does not answer core, core ends what it reaches and the answer is `503`
 * `consent_addresses_unavailable`, so the page asks for another try.
 */
export async function withdrawPromotionalConsent(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, consent, sessionUse } = access;
  try {
    const promotional = await consent.withdraw(sessionUse.session);
    return withRotatedHandle(noStore(NextResponse.json({ promotional })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

/**
 * `GET /api/account/promotional-consent/signup-offer`: whether the overview
 * shows the box (`source=signup`), and the CSRF proof it needs. Like the
 * e-mail nudge it is never in the way: once the session is known, any
 * failure (core off, the bearer, core's profile or list) is `200 { offer: false }`
 * and never ends the session. Core's profile is read first, so an account
 * that is not new costs no consent read.
 */
export async function promotionalSignupOfferRoute(request: NextRequest) {
  const services = getAuthServices();
  const authorization = await services.sessionAccess.authenticate(
    request.cookies.get(SESSION_COOKIE)?.value,
    { requestId: requestCorrelationId(request) },
  );
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") return authenticationRequiredResponse();

  const session = authorization.value.session;
  const none = noStore(NextResponse.json({ offer: false }));
  const consent = promotionalConsentServiceFor(services);
  const clubProfile = clubProfileServiceFor(services);
  if (!consent || !clubProfile) return none;
  try {
    const profile = await clubProfile.read(session);
    if (!offersSignupBox("none", profile.createdAt, session.createdAt)) return none;
    const state = await consent.read(session);
    if (!offersSignupBox(state, profile.createdAt, session.createdAt)) return none;
    return noStore(NextResponse.json({ offer: true, csrfToken: services.sessions.csrfToken(session.id) }));
  } catch {
    return none;
  }
}
