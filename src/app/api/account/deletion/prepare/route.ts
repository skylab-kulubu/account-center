import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  mutationHasExactOrigin,
  noStore,
  SESSION_COOKIE,
  setAccountDeletionProofCookie,
  setAccountDeletionReceiptCookie,
} from "@/server/auth/http";
import { requestCorrelationId } from "@/server/auth/logging";
import { getAuthServices } from "@/server/auth/services";
import { requireAccountSudo } from "@/server/auth/sudo-gate";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import { AccountDeletionProofError } from "@/server/account-deletion/orchestrator";
import { planDeletionReauthentication } from "@/server/account-deletion/reauthentication";

export const dynamic = "force-dynamic";

function unavailableResponse() {
  return noStore(NextResponse.json({ error: "unavailable" }, {
    status: 503,
    headers: { "Retry-After": "3" },
  }));
}

/**
 * The step between "yes, delete my account" and the literal confirmation
 * text: Sudo mode must hold a fresh proof, and only then does the BFF decide
 * how core's recent-authentication requirement will be met
 * (`planDeletionReauthentication`). With a fresh enough stored ID token the
 * durable intent is created here and the browser receives the proof and local
 * receipt cookies; otherwise the answer sends the page to the Keycloak
 * re-authentication hop. No subject, token or Keycloak detail reaches the
 * answer, which is `{ step }` and nothing else.
 */
export async function POST(request: NextRequest) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  if (!mutationHasExactOrigin(request, services.config)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (!services.accountDeletion) {
    return noStore(NextResponse.json({ error: "unavailable" }, {
      status: 503,
      headers: { "Retry-After": "60" },
    }));
  }
  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: false },
  );
  if (authorization.status === "forbidden") {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (authorization.status === "missing") return authenticationRequiredResponse();
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);

  const session = authorization.value.session;
  try {
    const sudo = await requireAccountSudo(services, session, { requestId });
    if (!sudo.ok) return sudo.response;
  } catch {
    // The identity service could not be read while building the challenge;
    // an empty method list would wrongly say no proof is possible.
    return unavailableResponse();
  }

  try {
    const stored = await services.sessions.readTokens(session.id);
    const plan = planDeletionReauthentication(stored?.tokens.idToken, {
      issuer: services.config.issuer,
      clientId: services.config.clientId,
      subject: session.subject,
    });
    if (plan.kind === "keycloak_reauthentication") {
      return noStore(NextResponse.json({ step: "keycloak_reauthentication" }));
    }
    // Only now is a bearer needed, so the hop answer never costs a token refresh.
    const accessToken = await services.account.accessToken(session);
    const intent = await services.accountDeletion.createReauthenticatedIntent({
      session,
      authenticatedAt: plan.authenticatedAt,
      freshAccessToken: accessToken,
      freshIdToken: plan.idToken,
    });
    const response = noStore(NextResponse.json({ step: "confirm" }));
    setAccountDeletionProofCookie(response, intent.proofReference, intent.freshUntil);
    setAccountDeletionReceiptCookie(response, intent.localReceipt, intent.freshUntil);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    // The window closed between the plan and the write: the hop is the way back.
    if (error instanceof AccountDeletionProofError) {
      return noStore(NextResponse.json({ step: "keycloak_reauthentication" }));
    }
    return unavailableResponse();
  }
}
