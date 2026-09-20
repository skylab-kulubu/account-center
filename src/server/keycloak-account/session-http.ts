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
import { toAccountProblem } from "@/server/keycloak-account/problem";

function forbiddenResponse() {
  return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
}

function problemResponse(request: NextRequest, error: unknown) {
  const problem = toAccountProblem(error);
  return noStore(NextResponse.json(
    { ...problem, instance: request.nextUrl.pathname },
    {
      status: problem.status,
      headers: { "content-type": "application/problem+json" },
    },
  ));
}

async function accountProblemResponse(
  request: NextRequest,
  sessionUse: {
    session: { id: string; absoluteExpiresAt: Date };
    rotatedHandle?: string;
  },
  error: unknown,
) {
  const services = getAuthServices();
  const response = problemResponse(request, error);
  if (response.status === 401) {
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
  } else if (sessionUse.rotatedHandle) {
    setSessionCookie(
      response,
      sessionUse.rotatedHandle,
      sessionUse.session.absoluteExpiresAt,
    );
  }
  return response;
}

export async function listManagedSessions(request: NextRequest) {
  const services = getAuthServices();
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = await services.sessionAccess.authenticate(handle);
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") return authenticationRequiredResponse();

  const session = authorization.value.session;
  try {
    return noStore(NextResponse.json({
      sessions: await services.account.managedSessions(session),
      csrfToken: services.sessions.csrfToken(session.id),
    }));
  } catch (error) {
    return accountProblemResponse(request, { session }, error);
  }
}

export async function revokeManagedSessions(
  request: NextRequest,
  operation: (
    services: ReturnType<typeof getAuthServices>,
    session: { id: string; subject: string },
  ) => Promise<void>,
) {
  const services = getAuthServices();
  if (!sessionMutationHasExactOrigin(request, services.config)) return forbiddenResponse();

  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = await services.sessionAccess.authenticateMutation(
    handle,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true },
  );
  if (authorization.status === "forbidden") return forbiddenResponse();
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") return authenticationRequiredResponse();

  const session = authorization.value.session;
  try {
    await operation(services, session);
  } catch (error) {
    return accountProblemResponse(request, authorization.value, error);
  }

  const response = noStore(new NextResponse(null, { status: 204 }));
  if (authorization.value.rotatedHandle) {
    setSessionCookie(
      response,
      authorization.value.rotatedHandle,
      authorization.value.session.absoluteExpiresAt,
    );
  }
  return response;
}
