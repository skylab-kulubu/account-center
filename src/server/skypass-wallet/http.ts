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
import { requireAccountSudo } from "@/server/auth/sudo-gate";
import { isCoreSkyPassWalletError } from "@/server/core/skypass-wallet-client";
import { skyPassWalletDisabledProblem, toSkyPassWalletProblem } from "@/server/skypass-wallet/problem";
import type { SkyPassWalletProblem } from "@/server/skypass-wallet/problem";
import { skyPassWalletServiceFor } from "@/server/skypass-wallet/service";

/**
 * Browser BFF routes for SkyPass in Google Wallet. Both are writes (core
 * writes the pass to Google), so they need the exact configured origin and
 * the session-bound CSRF proof, like the club-profile writes.
 *
 * Asking for a save link also needs Sudo mode (Yusuf, 2026-10-09): the link
 * puts a working door credential with the person's name on whichever Google
 * account saves it first, so a borrowed or hijacked session must not be
 * enough. It is a local `my.` gate (no SPI call), so any fresh proof counts,
 * the Microsoft re-authentication included. Ending the pass does not need
 * Sudo mode, like ending another session: it only protects (a lost phone
 * whose passkey may be the lost device), and misused it costs the person
 * one new link.
 *
 * The save link is answered to the browser that asked and goes nowhere
 * else: no log line, no event, no cache (`no-store`).
 */

type Services = ReturnType<typeof getAuthServices>;
type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: SkyPassWalletProblem) {
  const response = noStore(NextResponse.json(
    { ...problem, instance: request.nextUrl.pathname },
    { status: problem.status, headers: { "content-type": "application/problem+json" } },
  ));
  if (problem.retryAfterSeconds !== undefined) response.headers.set("Retry-After", String(problem.retryAfterSeconds));
  return response;
}

function forbiddenResponse() {
  return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
}

function withRotatedHandle(response: NextResponse, sessionUse: SessionUse) {
  if (sessionUse.rotatedHandle) {
    setSessionCookie(response, sessionUse.rotatedHandle, sessionUse.session.absoluteExpiresAt);
  }
  return response;
}

/** A Keycloak-side 401 ends the local session like every account route; a core 401 only reports it. */
async function failureResponse(request: NextRequest, services: Services, sessionUse: SessionUse, error: unknown) {
  const response = problemResponse(request, toSkyPassWalletProblem(error));
  if (response.status === 401 && !isCoreSkyPassWalletError(error)) {
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

async function authenticateMutation(request: NextRequest) {
  const services = getAuthServices();
  if (!sessionMutationHasExactOrigin(request, services.config)) return { ok: false as const, response: forbiddenResponse() };
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = await services.sessionAccess.authenticateMutation(
    handle,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true },
  );
  if (authorization.status === "forbidden") return { ok: false as const, response: forbiddenResponse() };
  if (authorization.status === "unavailable") return { ok: false as const, response: accountAccessUnavailableResponse() };
  if (authorization.status === "blocked") return { ok: false as const, response: authenticationRequiredResponse(true) };
  if (authorization.status !== "active") return { ok: false as const, response: authenticationRequiredResponse() };
  const wallet = skyPassWalletServiceFor(services);
  if (!wallet) {
    return {
      ok: false as const,
      response: withRotatedHandle(problemResponse(request, skyPassWalletDisabledProblem), authorization.value),
    };
  }
  return { ok: true as const, services, wallet, sessionUse: authorization.value as SessionUse };
}

/** `POST /api/account/skypass/wallet/google`: `{ saveUrl }` for the browser to open at once, behind Sudo mode (`428` otherwise). */
export async function createGoogleWalletLink(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, wallet, sessionUse } = access;
  try {
    const gate = await requireAccountSudo(services, sessionUse.session, { requestId: requestCorrelationId(request) });
    if (!gate.ok) return withRotatedHandle(gate.response, sessionUse);
    const saveUrl = await wallet.googleSaveUrl(sessionUse.session);
    return withRotatedHandle(noStore(NextResponse.json({ saveUrl })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

/** `DELETE /api/account/skypass/wallet/google`: ends the pass (lost or replaced phone). */
export async function revokeGoogleWalletPass(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, wallet, sessionUse } = access;
  try {
    await wallet.revokeGoogle(sessionUse.session);
    return withRotatedHandle(noStore(new NextResponse(null, { status: 204 })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}
