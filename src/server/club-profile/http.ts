import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { CLUB_PROFILE_PICTURE_FIELD, CLUB_PROFILE_PICTURE_MAX_BYTES } from "@/config/club-profile";
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
import {
  clubProfileDisabledProblem,
  isCoreProfileError,
  toClubProfileProblem,
} from "@/server/club-profile/problem";
import type { ClubProfileProblem } from "@/server/club-profile/problem";
import { clubProfileServiceFor, toClubProfileView } from "@/server/club-profile/service";
import type { ClubProfileService } from "@/server/club-profile/service";
import { ClubProfileValidationError } from "@/server/club-profile/validation";

/**
 * Browser BFF routes for the club profile. Reads need an active session behind
 * the access gate; writes additionally need the exact configured origin and
 * the session-bound CSRF proof. None of them requires Sudo mode: the fields
 * and the picture are club data, not credentials or identity.
 */

const PATCH_BODY_MAX_BYTES = 4 * 1_024;
/** Multipart framing and the field headers on top of the picture itself. */
const PICTURE_BODY_OVERHEAD_BYTES = 64 * 1_024;

type Services = ReturnType<typeof getAuthServices>;
type SessionUse = { session: { id: string; absoluteExpiresAt: Date; subject: string }; rotatedHandle?: string };

function problemResponse(request: NextRequest, problem: ClubProfileProblem) {
  return noStore(NextResponse.json(
    { ...problem, instance: request.nextUrl.pathname },
    { status: problem.status, headers: { "content-type": "application/problem+json" } },
  ));
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

/**
 * Maps a failure to a problem response. A 401 that comes from the Keycloak
 * session path (token cannot be refreshed) ends the local session like every
 * other account route; a core 401 only reports the problem, because the
 * identity session itself is still valid.
 */
async function failureResponse(request: NextRequest, services: Services, sessionUse: SessionUse, error: unknown) {
  const response = problemResponse(request, toClubProfileProblem(error));
  if (response.status === 401 && !isCoreProfileError(error)) {
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
  | { ok: true; services: Services; clubProfile: ClubProfileService; sessionUse: SessionUse }
  | { ok: false; response: NextResponse };

async function authenticateRead(request: NextRequest): Promise<Authenticated> {
  const services = getAuthServices();
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = await services.sessionAccess.authenticate(handle);
  if (authorization.status === "unavailable") return { ok: false, response: accountAccessUnavailableResponse() };
  if (authorization.status === "blocked") return { ok: false, response: authenticationRequiredResponse(true) };
  if (authorization.status !== "active") return { ok: false, response: authenticationRequiredResponse() };
  const clubProfile = clubProfileServiceFor(services);
  if (!clubProfile) return { ok: false, response: problemResponse(request, clubProfileDisabledProblem) };
  return { ok: true, services, clubProfile, sessionUse: { session: authorization.value.session } };
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
  const clubProfile = clubProfileServiceFor(services);
  if (!clubProfile) {
    return { ok: false, response: withRotatedHandle(problemResponse(request, clubProfileDisabledProblem), authorization.value) };
  }
  return { ok: true, services, clubProfile, sessionUse: authorization.value };
}

export async function readClubProfile(request: NextRequest) {
  const access = await authenticateRead(request);
  if (!access.ok) return access.response;
  const { services, clubProfile, sessionUse } = access;
  try {
    return noStore(NextResponse.json({
      profile: toClubProfileView(await clubProfile.read(sessionUse.session)),
      csrfToken: services.sessions.csrfToken(sessionUse.session.id),
    }));
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const bytes = await readBytesBody(request, {
    maxBytes: PATCH_BODY_MAX_BYTES,
    contentType: (value) => value === "application/json",
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ClubProfileValidationError("body", "invalid_body");
  }
}

export async function updateClubProfile(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, clubProfile, sessionUse } = access;
  try {
    const body = await readJsonBody(request);
    const result = await clubProfile.update(sessionUse.session, body);
    return withRotatedHandle(
      noStore(NextResponse.json({ profile: toClubProfileView(result.profile), changed: result.changed })),
      sessionUse,
    );
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

async function readPictureBytes(request: NextRequest) {
  const bytes = await readBytesBody(request, {
    maxBytes: CLUB_PROFILE_PICTURE_MAX_BYTES + PICTURE_BODY_OVERHEAD_BYTES,
    contentType: (value) => value.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data",
  });
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": request.headers.get("content-type")! } }).formData();
  } catch {
    throw new RequestBodyError(400);
  }
  const file = form.get(CLUB_PROFILE_PICTURE_FIELD);
  if (!(file instanceof Blob)) throw new RequestBodyError(400);
  return new Uint8Array(await file.arrayBuffer());
}

export async function uploadClubProfilePicture(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, clubProfile, sessionUse } = access;
  try {
    const bytes = await readPictureBytes(request);
    const profile = toClubProfileView(await clubProfile.uploadPicture(sessionUse.session, bytes));
    return withRotatedHandle(noStore(NextResponse.json({ profile })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}

export async function removeClubProfilePicture(request: NextRequest) {
  const access = await authenticateMutation(request);
  if (!access.ok) return access.response;
  const { services, clubProfile, sessionUse } = access;
  try {
    const profile = toClubProfileView(await clubProfile.removePicture(sessionUse.session));
    return withRotatedHandle(noStore(NextResponse.json({ profile })), sessionUse);
  } catch (error) {
    return failureResponse(request, services, sessionUse, error);
  }
}
