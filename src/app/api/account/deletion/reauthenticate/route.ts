import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  mutationHasExactOrigin,
  noStore,
  requestWantsHtmlNavigation,
  SESSION_COOKIE,
  setOidcTransactionCookie,
  setSessionCookie,
} from "@/server/auth/http";
import { readUrlEncodedBody, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const services = getAuthServices();
  const htmlNavigation = requestWantsHtmlNavigation(request);
  if (!mutationHasExactOrigin(request, services.config)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  let form: URLSearchParams;
  try {
    form = await readUrlEncodedBody(request, { maxBytes: 512, exactContentType: true });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }
  if (!services.accountDeletion) {
    if (htmlNavigation) {
      const response = NextResponse.redirect(
        new URL("/delete-account?deletionError=reauth_unavailable", services.config.appUrl),
        303,
      );
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Retry-After", "60");
      return noStore(response);
    }
    return noStore(NextResponse.json({ error: "unavailable" }, {
      status: 503,
      headers: { "Retry-After": "60" },
    }));
  }
  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    form.get("csrfToken") ?? undefined,
    { allowRotation: true },
  );
  if (authorization.status === "forbidden") {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (authorization.status === "missing") return authenticationRequiredResponse();
  if (authorization.status === "unavailable") {
    if (!htmlNavigation) return accountAccessUnavailableResponse();
    const response = NextResponse.redirect(
      new URL("/delete-account?deletionError=reauth_unavailable", services.config.appUrl),
      303,
    );
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Retry-After", "3");
    return noStore(response);
  }
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);

  try {
    const started = await services.oidc.beginAccountDeletionReauthentication(
      authorization.value.session,
    );
    const response = NextResponse.redirect(started.authorizationUrl, 303);
    setOidcTransactionCookie(response, started.browserBinding);
    if (authorization.value.rotatedHandle) {
      setSessionCookie(
        response,
        authorization.value.rotatedHandle,
        authorization.value.session.absoluteExpiresAt,
      );
    }
    response.headers.set("Referrer-Policy", "no-referrer");
    return noStore(response);
  } catch {
    const response = htmlNavigation
      ? NextResponse.redirect(
          new URL("/delete-account?deletionError=reauth_unavailable", services.config.appUrl),
          303,
        )
      : NextResponse.json({ error: "unavailable" }, { status: 503 });
    if (authorization.value.rotatedHandle) {
      setSessionCookie(
        response,
        authorization.value.rotatedHandle,
        authorization.value.session.absoluteExpiresAt,
      );
    }
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Retry-After", "3");
    return noStore(response);
  }
}
