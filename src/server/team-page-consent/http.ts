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
import { getAuthServices } from "@/server/auth/services";
import { CoreConsentError } from "@/server/core/consents-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import { teamPageConsentServiceFor } from "@/server/team-page-consent/service";
import type { TeamPageConsentService } from "@/server/team-page-consent/service";

/**
 * Browser BFF routes for the team page consent ("Ekip sayfalarında
 * görüneyim", core `docs/team-page-consent.md`). Writing needs the exact
 * configured origin and the session-bound CSRF proof, like the promotional
 * consent, and no Sudo mode. The purpose, the text version and the source
 * are the BFF's: the browser sends no body.
 */

const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

export type TeamPageConsentProblem = AccountProblem & { code?: string; retryAfterSeconds?: number };

/** `CORE_API_URL` is unset, or core records no consents (`CONTACT_CONSENT_KEY` unset): the switch is not shown. */
export const teamPageConsentOffProblem: TeamPageConsentProblem = {
  type: `${PROBLEM_BASE}team-page-consent-unavailable`,
  title: "Ekip sayfası ayarı şu an kullanılamıyor",
  status: 503,
  detail: "Bu ortamda kapalı; hiçbir şey kaydedilmedi.",
  code: "consents_unavailable",
};

export function toTeamPageConsentProblem(error: unknown): TeamPageConsentProblem {
  if (!(error instanceof CoreConsentError)) return toAccountProblem(error);
  switch (error.failure) {
    case "off":
      return teamPageConsentOffProblem;
    case "addresses_unavailable":
      return {
        type: `${PROBLEM_BASE}team-page-consent-addresses-unavailable`,
        title: "Hesabın şu an okunamadı",
        status: 503,
        detail: "Biraz sonra yeniden dene.",
        code: "consent_addresses_unavailable",
        ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
    case "unauthorized":
      return {
        type: `${PROBLEM_BASE}team-page-consent-reauthentication`,
        title: "Yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Oturumunun core erişimi doğrulanamadı; ayarın değişmedi.",
      };
    case "forbidden":
      return {
        type: `${PROBLEM_BASE}team-page-consent-forbidden`,
        title: "Ekip sayfası ayarı bu hesap için kullanılamıyor",
        status: 403,
        detail: "Core bu hesap için ayarı yazmadı.",
      };
    case "contract":
      return {
        type: `${PROBLEM_BASE}team-page-consent-contract`,
        title: "Ekip sayfası ayarı güvenle durduruldu",
        status: 502,
        detail: "Core yanıtı beklenen biçimde değildi. Sayfayı yenileyip yeniden dene.",
      };
    case "rejected":
    case "invalid_input":
      return {
        type: `${PROBLEM_BASE}team-page-consent-rejected`,
        title: "Core isteği kabul etmedi",
        status: 400,
        detail: "Sayfayı yenileyip yeniden dene; ayarın değişmedi.",
      };
    case "unavailable":
      return {
        type: `${PROBLEM_BASE}team-page-consent-core-unavailable`,
        title: "Ekip sayfası ayarına şu anda ulaşılamıyor",
        status: 503,
        detail: "Core yanıt vermedi; ayarın değişmedi. Biraz sonra yeniden dene.",
      };
  }
}

type Services = ReturnType<typeof getAuthServices>;
type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: TeamPageConsentProblem) {
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
  const response = problemResponse(request, toTeamPageConsentProblem(error));
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
  | { ok: true; services: Services; consent: TeamPageConsentService; sessionUse: SessionUse }
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
  const consent = teamPageConsentServiceFor(services);
  if (!consent) {
    return { ok: false, response: withRotatedHandle(problemResponse(request, teamPageConsentOffProblem), authorization.value) };
  }
  return { ok: true, services, consent, sessionUse: authorization.value };
}

/** `POST /api/account/team-page-consent` → `{ teamPage: "active" }`. */
export async function grantTeamPageConsent(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, consent, sessionUse } = access;
  try {
    const teamPage = await consent.grant(sessionUse.session);
    return withRotatedHandle(noStore(NextResponse.json({ teamPage })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

/** `DELETE /api/account/team-page-consent` → `{ teamPage: "none" }`: the person is hidden from the public team pages at once. */
export async function withdrawTeamPageConsent(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, consent, sessionUse } = access;
  try {
    const teamPage = await consent.withdraw(sessionUse.session);
    return withRotatedHandle(noStore(NextResponse.json({ teamPage })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}
