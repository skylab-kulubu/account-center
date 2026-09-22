import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ACCOUNT_DELETION_PROOF_COOKIE,
  ACCOUNT_DELETION_RECEIPT_COOKIE,
  clearAccountDeletionProofCookie,
  clearAccountDeletionReceiptCookie,
  clearSessionCookie,
  mutationHasExactOrigin,
  noStore,
  requestWantsHtmlNavigation,
  SESSION_COOKIE,
  setAccountDeletionReceiptCookie,
} from "@/server/auth/http";
import { readUrlEncodedBody, RequestBodyError } from "@/server/auth/request-body";
import { requestCorrelationId } from "@/server/auth/logging";
import { getAuthServices } from "@/server/auth/services";
import { requireAccountSudo } from "@/server/auth/sudo-gate";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import {
  AccountDeletionProofError,
  AccountDeletionUnavailableError,
} from "@/server/account-deletion/orchestrator";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const services = getAuthServices();
  const requestId = requestCorrelationId(request);
  const htmlNavigation = requestWantsHtmlNavigation(request);
  if (!mutationHasExactOrigin(request, services.config)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  let form: URLSearchParams;
  try {
    form = await readUrlEncodedBody(request, { maxBytes: 1_024, exactContentType: true });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }
  if (!services.accountDeletion) {
    if (htmlNavigation) {
      const response = NextResponse.redirect(
        new URL("/delete-account?deletionError=deletion_unavailable", services.config.appUrl),
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
    { allowRotation: false },
  );
  if (authorization.status === "forbidden") {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (authorization.status === "missing") return authenticationRequiredResponse();
  if (authorization.status === "unavailable") {
    if (!htmlNavigation) return accountAccessUnavailableResponse();
    const response = NextResponse.redirect(
      new URL("/delete-account?deletionError=deletion_unavailable", services.config.appUrl),
      303,
    );
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Retry-After", "3");
    return noStore(response);
  }
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);

  // Sudo mode is the person's re-authentication for this flow, so the last
  // irreversible step refuses to run on a proof that has meanwhile expired.
  try {
    const sudo = await requireAccountSudo(services, authorization.value.session, { requestId });
    if (!sudo.ok) {
      if (!htmlNavigation) return sudo.response;
      const response = NextResponse.redirect(
        new URL("/delete-account?deletionError=sudo_required", services.config.appUrl),
        303,
      );
      response.headers.set("Referrer-Policy", "no-referrer");
      return noStore(response);
    }
  } catch {
    if (!htmlNavigation) {
      return noStore(NextResponse.json({ error: "unavailable" }, {
        status: 503,
        headers: { "Retry-After": "3" },
      }));
    }
    const response = NextResponse.redirect(
      new URL("/delete-account?deletionError=deletion_unavailable", services.config.appUrl),
      303,
    );
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Retry-After", "3");
    return noStore(response);
  }

  try {
    const result = await services.accountDeletion.submit({
      session: authorization.value.session,
      proofReference: request.cookies.get(ACCOUNT_DELETION_PROOF_COOKIE)?.value ?? "",
      localReceipt: request.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)?.value ?? "",
      confirmation: form.get("confirmation") ?? "",
    });
    if (!result.receiptExpiresAt) throw new AccountDeletionUnavailableError();
    const response = NextResponse.redirect(
      new URL("/account-deletion", services.config.appUrl),
      303,
    );
    setAccountDeletionReceiptCookie(
      response,
      result.receipt,
      new Date(result.receiptExpiresAt),
    );
    clearAccountDeletionProofCookie(response);
    clearSessionCookie(response);
    response.headers.set("Referrer-Policy", "no-referrer");
    return noStore(response);
  } catch (error) {
    if (error instanceof AccountDeletionProofError) {
      if (htmlNavigation) {
        const response = NextResponse.redirect(
          new URL("/delete-account?deletionError=proof_expired", services.config.appUrl),
          303,
        );
        clearAccountDeletionProofCookie(response);
        clearAccountDeletionReceiptCookie(response);
        response.headers.set("Referrer-Policy", "no-referrer");
        return noStore(response);
      }
      return noStore(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
    }
    if (error instanceof AccountDeletionUnavailableError) {
      if (!htmlNavigation) {
        return noStore(NextResponse.json({ error: "unavailable" }, {
          status: 503,
          headers: { "Retry-After": "3" },
        }));
      }
      const response = NextResponse.redirect(
        new URL("/account-deletion?recovery=1", services.config.appUrl),
        303,
      );
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Retry-After", "3");
      return noStore(response);
    }
    if (htmlNavigation) {
      const response = NextResponse.redirect(
        new URL("/delete-account?deletionError=deletion_unavailable", services.config.appUrl),
        303,
      );
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Retry-After", "3");
      return noStore(response);
    }
    return noStore(NextResponse.json({ error: "unavailable" }, {
      status: 503,
      headers: { "Retry-After": "3" },
    }));
  }
}
