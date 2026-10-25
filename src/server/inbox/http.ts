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
import { inboxDisabledProblem, toInboxProblem } from "@/server/inbox/problem";
import type { InboxProblem } from "@/server/inbox/problem";
import { inboxServiceFor } from "@/server/inbox/service";
import type { InboxService } from "@/server/inbox/service";
import { SkyMailInboxError } from "@/server/skymail/inbox-client";

/**
 * Browser BFF routes for the in-app inbox ("Bildirimlerim", iletişim-servisi
 * 07; SkyMail `docs/inbox.md`). Reading needs an active session behind the
 * access gate; marking also needs the exact configured origin and the
 * session-bound CSRF proof, like the preference writes. No Sudo mode: read
 * marks change nothing about the account. SkyMail is called only from here,
 * with the session's token; the browser never holds it.
 */

type Services = ReturnType<typeof getAuthServices>;
type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: InboxProblem) {
  return noStore(NextResponse.json(
    { ...problem, instance: request.nextUrl.pathname },
    { status: problem.status, headers: { "content-type": "application/problem+json" } },
  ));
}

function withRotatedHandle(response: NextResponse, sessionUse: SessionUse) {
  if (sessionUse.rotatedHandle) setSessionCookie(response, sessionUse.rotatedHandle, sessionUse.session.absoluteExpiresAt);
  return response;
}

/** A Keycloak-side 401 ends the local session like every account route; a SkyMail 401 only reports it. */
async function failureResponse(request: NextRequest, services: Services, sessionUse: SessionUse, error: unknown) {
  const response = problemResponse(request, toInboxProblem(error));
  if (response.status === 401 && !(error instanceof SkyMailInboxError)) {
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
  | { ok: true; services: Services; inbox: InboxService; sessionUse: SessionUse }
  | { ok: false; response: NextResponse };

async function authenticateRead(request: NextRequest): Promise<Authenticated> {
  const services = getAuthServices();
  const authorization = await services.sessionAccess.authenticate(request.cookies.get(SESSION_COOKIE)?.value);
  if (authorization.status === "unavailable") return { ok: false, response: accountAccessUnavailableResponse() };
  if (authorization.status === "blocked") return { ok: false, response: authenticationRequiredResponse(true) };
  if (authorization.status !== "active") return { ok: false, response: authenticationRequiredResponse() };
  const inbox = inboxServiceFor(services);
  if (!inbox) return { ok: false, response: problemResponse(request, inboxDisabledProblem) };
  return { ok: true, services, inbox, sessionUse: { session: authorization.value.session } };
}

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
  const inbox = inboxServiceFor(services);
  if (!inbox) {
    return { ok: false, response: withRotatedHandle(problemResponse(request, inboxDisabledProblem), authorization.value) };
  }
  return { ok: true, services, inbox, sessionUse: authorization.value };
}

async function answer<T>(
  request: NextRequest,
  access: Authenticated,
  operation: (inbox: InboxService, session: SessionUse["session"]) => Promise<T>,
  body: (value: T) => Record<string, unknown>,
) {
  if (!access.ok) return access.response;
  const { services, inbox, sessionUse } = access;
  try {
    return withRotatedHandle(noStore(NextResponse.json(body(await operation(inbox, sessionUse.session)))), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

/** `GET /api/account/inbox[?cursor=…]`: `{ page: { items, nextCursor } }`, newest first, archived left out. */
export async function readInbox(request: NextRequest) {
  const cursor = request.nextUrl.searchParams.get("cursor");
  return answer(request, await authenticateRead(request), (inbox, session) => inbox.list(session, cursor), (page) => ({ page }));
}

/** `GET /api/account/inbox/counts`: `{ counts: { unseen, unread } }`, the shell's badge. */
export async function readInboxCounts(request: NextRequest) {
  return answer(request, await authenticateRead(request), (inbox, session) => inbox.counts(session), (counts) => ({ counts }));
}

/** `POST /api/account/inbox/items/{id}/{read|unread|archive}`: `{ item }`. */
export async function markInboxItem(request: NextRequest, id: string, action: string) {
  return answer(request, await authenticateMutation(request), (inbox, session) => inbox.mark(session, id, action), (item) => ({ item }));
}

/** `POST /api/account/inbox/{read-all|seen-all}`: `{ updated }`. */
export async function markAllInbox(request: NextRequest, action: "read-all" | "seen-all") {
  return answer(request, await authenticateMutation(request), (inbox, session) => inbox.markAll(session, action), (updated) => ({ updated }));
}
