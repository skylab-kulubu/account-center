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
import { readBytesBody } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import {
  communicationPreferencesDisabledProblem,
  toCommunicationPreferencesProblem,
} from "@/server/communication-preferences/problem";
import type { CommunicationPreferencesProblem } from "@/server/communication-preferences/problem";
import {
  communicationPreferencesServiceFor,
  CommunicationPreferencesInputError,
} from "@/server/communication-preferences/service";
import type { CommunicationPreferencesService } from "@/server/communication-preferences/service";
import { CoreCommunicationPreferencesError } from "@/server/core/communication-preferences-client";

/**
 * Browser BFF routes for the communication preferences ("İletişim
 * tercihleri", core `docs/communication-preferences.md`). Reading needs an
 * active session behind the access gate; writing also needs the exact
 * configured origin and the session-bound CSRF proof, like the club-profile
 * writes. Neither needs Sudo mode (bilet 09): these are mail choices, and
 * every News mail carries a one-click link that changes them without any
 * sign-in at all.
 */

/** 200 items of `team:<64-character id>:duyuru` with `enabled` fit well inside this. */
const PUT_BODY_MAX_BYTES = 32 * 1_024;

type Services = ReturnType<typeof getAuthServices>;
type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: CommunicationPreferencesProblem) {
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
  const response = problemResponse(request, toCommunicationPreferencesProblem(error));
  if (response.status === 401 && !(error instanceof CoreCommunicationPreferencesError)) {
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
  | { ok: true; services: Services; preferences: CommunicationPreferencesService; sessionUse: SessionUse }
  | { ok: false; response: NextResponse };

async function authenticateRead(request: NextRequest): Promise<Authenticated> {
  const services = getAuthServices();
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = await services.sessionAccess.authenticate(handle);
  if (authorization.status === "unavailable") return { ok: false, response: accountAccessUnavailableResponse() };
  if (authorization.status === "blocked") return { ok: false, response: authenticationRequiredResponse(true) };
  if (authorization.status !== "active") return { ok: false, response: authenticationRequiredResponse() };
  const preferences = communicationPreferencesServiceFor(services);
  if (!preferences) return { ok: false, response: problemResponse(request, communicationPreferencesDisabledProblem) };
  return { ok: true, services, preferences, sessionUse: { session: authorization.value.session } };
}

async function authenticateMutation(request: NextRequest): Promise<Authenticated> {
  const services = getAuthServices();
  if (!sessionMutationHasExactOrigin(request, services.config)) return { ok: false, response: forbiddenResponse() };
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = await services.sessionAccess.authenticateMutation(
    handle,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true },
  );
  if (authorization.status === "forbidden") return { ok: false, response: forbiddenResponse() };
  if (authorization.status === "unavailable") return { ok: false, response: accountAccessUnavailableResponse() };
  if (authorization.status === "blocked") return { ok: false, response: authenticationRequiredResponse(true) };
  if (authorization.status !== "active") return { ok: false, response: authenticationRequiredResponse() };
  const preferences = communicationPreferencesServiceFor(services);
  if (!preferences) {
    return {
      ok: false,
      response: withRotatedHandle(problemResponse(request, communicationPreferencesDisabledProblem), authorization.value),
    };
  }
  return { ok: true, services, preferences, sessionUse: authorization.value };
}

/** `GET /api/account/communication-preferences`: `{ preferences }`, the e-mail view of core's screen. */
export async function readCommunicationPreferences(request: NextRequest) {
  const access = await authenticateRead(request);
  if (!access.ok) return access.response;
  const { services, preferences, sessionUse } = access;
  try {
    return noStore(NextResponse.json({ preferences: await preferences.read(sessionUse.session) }));
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const bytes = await readBytesBody(request, {
    maxBytes: PUT_BODY_MAX_BYTES,
    contentType: (value) => value === "application/json",
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CommunicationPreferencesInputError();
  }
}

/** `PUT /api/account/communication-preferences`: `{"items": [{category, enabled}], "tracking": {enabled}}` (either or both) → `{ preferences }`. */
export async function updateCommunicationPreferences(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, preferences, sessionUse } = access;
  try {
    const body = await readJsonBody(request);
    const view = await preferences.update(sessionUse.session, body);
    return withRotatedHandle(noStore(NextResponse.json({ preferences: view })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}
