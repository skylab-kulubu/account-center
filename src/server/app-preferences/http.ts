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
import { isAppPreferenceApp } from "@/lib/app-preferences";
import { appPreferencesServiceFor } from "@/server/app-preferences/service";
import { CoreAppPreferencesError } from "@/server/core/app-preferences-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";

/**
 * Browser BFF route for resetting one app's preferences ("Sıfırla", core
 * `docs/app-preferences.md`). Needs the exact configured origin and the
 * session-bound CSRF proof like every account write; no Sudo mode.
 */

const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

export const appPreferencesDisabledProblem: AccountProblem = {
  type: `${PROBLEM_BASE}app-preferences-disabled`,
  title: "Uygulama ayarları bu ortamda kapalı",
  status: 503,
  detail: "Hiçbir şey değişmedi.",
};

const invalidAppProblem: AccountProblem = {
  type: `${PROBLEM_BASE}app-preferences-invalid`,
  title: "İstek okunamadı",
  status: 400,
  detail: "Sayfayı yenileyip yeniden dene.",
};

export function toAppPreferencesProblem(error: unknown): AccountProblem {
  if (!(error instanceof CoreAppPreferencesError)) return toAccountProblem(error);
  switch (error.failure) {
    case "unauthorized":
      return {
        type: `${PROBLEM_BASE}app-preferences-reauthentication`,
        title: "Yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Oturumunun core erişimi doğrulanamadı; ayarların değişmedi.",
      };
    case "forbidden":
    case "subject_inactive":
      return {
        type: `${PROBLEM_BASE}app-preferences-forbidden`,
        title: "Uygulama ayarları bu hesap için kullanılamıyor",
        status: 403,
        detail: "Ayarların değişmedi.",
      };
    case "rate_limited":
      return {
        type: `${PROBLEM_BASE}app-preferences-rate-limited`,
        title: "Çok fazla istek",
        status: 429,
        detail: "Bir dakika sonra yeniden dene.",
      };
    case "contract":
      return {
        type: `${PROBLEM_BASE}app-preferences-contract`,
        title: "Uygulama ayarları güvenle durduruldu",
        status: 502,
        detail: "Core yanıtı beklenen biçimde değildi. Sayfayı yenileyip yeniden dene.",
      };
    case "off":
    case "rejected":
    case "invalid_input":
      return { ...invalidAppProblem, title: "Core isteği kabul etmedi" };
    case "unavailable":
      return {
        type: `${PROBLEM_BASE}app-preferences-core-unavailable`,
        title: "Uygulama ayarlarına şu anda ulaşılamıyor",
        status: 503,
        detail: "Ayarların değişmedi. Biraz sonra yeniden dene.",
      };
  }
}

type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: AccountProblem) {
  return noStore(NextResponse.json(
    { ...problem, instance: request.nextUrl.pathname },
    { status: problem.status, headers: { "content-type": "application/problem+json" } },
  ));
}

function forbiddenResponse() {
  return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
}

function withRotatedHandle(response: NextResponse, sessionUse: SessionUse) {
  if (sessionUse.rotatedHandle) setSessionCookie(response, sessionUse.rotatedHandle, sessionUse.session.absoluteExpiresAt);
  return response;
}

/** `DELETE /api/account/app-preferences/{app}` → 204: every key of the app is gone, its default is back. */
export async function resetAppPreferences(request: NextRequest, app: string) {
  const services = getAuthServices();
  if (!sessionMutationHasExactOrigin(request, services.config)) return forbiddenResponse();
  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true },
  );
  if (authorization.status === "forbidden") return forbiddenResponse();
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") return authenticationRequiredResponse();
  const sessionUse: SessionUse = authorization.value;
  const preferences = appPreferencesServiceFor(services);
  if (!preferences) return withRotatedHandle(problemResponse(request, appPreferencesDisabledProblem), sessionUse);
  if (!isAppPreferenceApp(app)) return withRotatedHandle(problemResponse(request, invalidAppProblem), sessionUse);

  try {
    await preferences.reset(sessionUse.session, app);
    return withRotatedHandle(noStore(new NextResponse(null, { status: 204 })), sessionUse);
  } catch (error) {
    const response = problemResponse(request, toAppPreferencesProblem(error));
    // A Keycloak-side 401 ends the local session like every account route; a core 401 only reports it.
    if (response.status === 401 && !(error instanceof CoreAppPreferencesError)) {
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
}
