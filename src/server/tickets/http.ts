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
import { CoreTicketsError } from "@/server/core/tickets-client";
import { ticketsDisabledProblem, toTicketsProblem } from "@/server/tickets/problem";
import type { TicketsProblem } from "@/server/tickets/problem";
import { ticketsServiceFor } from "@/server/tickets/service";

/**
 * Browser BFF route for the holder's cancel ("Biletlerim",
 * kontenjan-iptal-hatirlatma 14). A write: the exact configured origin and
 * the session-bound CSRF proof, like the inbox marks. No Sudo mode: the
 * organizer can take a cancellation back, and the ticket mail says so.
 */

type Services = ReturnType<typeof getAuthServices>;
type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: TicketsProblem) {
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

/** A Keycloak-side 401 ends the local session like every account route; a core 401 only reports it. */
async function failureResponse(request: NextRequest, services: Services, sessionUse: SessionUse, error: unknown) {
  const response = problemResponse(request, toTicketsProblem(error));
  if (response.status === 401 && !(error instanceof CoreTicketsError)) {
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

/** `POST /api/account/tickets/{id}/cancel`: `204`; a refusal is a problem with core's `code`. */
export async function cancelTicket(request: NextRequest, ticketId: string) {
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
  const sessionUse = authorization.value as SessionUse;
  const tickets = ticketsServiceFor(services);
  if (!tickets) return withRotatedHandle(problemResponse(request, ticketsDisabledProblem), sessionUse);
  try {
    await tickets.cancel(sessionUse.session, ticketId);
    return withRotatedHandle(noStore(new NextResponse(null, { status: 204 })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}
