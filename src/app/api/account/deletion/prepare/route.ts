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
import { requireAccountSpiSudo, sudoRequiredResponse } from "@/server/auth/sudo-gate";
import type { SudoSpiProof } from "@/server/auth/sudo-gate";
import { resolveSudoMethods } from "@/server/auth/sudo-methods";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import {
  ACCOUNT_DELETION_BEARER_VALIDITY_MS,
  accountDeletionErrorKind,
} from "@/server/account-deletion/orchestrator";

export const dynamic = "force-dynamic";

function unavailableResponse() {
  return noStore(NextResponse.json({ error: "unavailable" }, {
    status: 503,
    headers: { "Retry-After": "3" },
  }));
}

/**
 * The step between "yes, delete my account" and the literal confirmation
 * text. Sudo mode must hold a fresh proof that carries sky-account material
 * (the same gate every `X-Sky-Sudo` route uses, so a token-less Microsoft
 * proof is answered `428 spi_token_required`), because that sudo token is
 * what core verifies on the intake. The durable intent seals the bearer and
 * the proof, and the browser receives the proof and local receipt cookies.
 * No subject, token or Keycloak detail reaches the answer, which is
 * `{ step }` and nothing else.
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
  let sudo: SudoSpiProof;
  try {
    const gate = await requireAccountSpiSudo(services, session, { requestId });
    if (!gate.ok) return gate.response;
    sudo = gate.proof;
  } catch {
    // The identity service could not be read while building the challenge;
    // an empty method list would wrongly say no proof is possible.
    return unavailableResponse();
  }

  try {
    // The bearer is sealed for the whole recovery window, and a recovery
    // replay after the deletion closed the Keycloak session cannot refresh
    // it: take one that outlives the window, refreshed if the current one
    // would lapse sooner. The intent's window also ends before it does.
    const bearer = await services.account.accessTokenWithExpiry(session, {
      minimumValidityMs: ACCOUNT_DELETION_BEARER_VALIDITY_MS,
    });
    const intent = await services.accountDeletion.createReauthenticatedIntent({
      session,
      accessToken: bearer.accessToken,
      accessTokenExpiresAt: bearer.expiresAt,
      sudo,
    });
    const response = noStore(NextResponse.json({ step: "confirm" }));
    setAccountDeletionProofCookie(response, intent.proofReference, intent.freshUntil);
    setAccountDeletionReceiptCookie(response, intent.localReceipt, intent.freshUntil);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    // The proof lapsed between the gate and the write: the dialog is the way back.
    if (accountDeletionErrorKind(error) === "proof") {
      const availability = await resolveSudoMethods(services, session).catch(() => null);
      if (!availability) return unavailableResponse();
      return sudoRequiredResponse({ reason: "expired", ...availability });
    }
    return unavailableResponse();
  }
}
