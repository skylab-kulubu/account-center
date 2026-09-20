import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ACCOUNT_DELETION_RECEIPT_COOKIE,
  noStore,
  sessionMutationHasExactOrigin,
  setAccountDeletionReceiptCookie,
} from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";
import { AccountDeletionProofError } from "@/server/account-deletion/orchestrator";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const services = getAuthServices();
  if (!sessionMutationHasExactOrigin(request, services.config)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  if (!services.accountDeletion) {
    return noStore(NextResponse.json({ error: "unavailable" }, {
      status: 503,
      headers: { "Retry-After": "60" },
    }));
  }
  const receipt = request.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)?.value ?? "";
  if (!services.accountDeletion.verifyReceiptCsrf(
    receipt,
    request.headers.get("x-csrf-token") ?? undefined,
  )) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  try {
    const result = await services.accountDeletion.retry(receipt);
    if (!result.receiptExpiresAt) throw new Error();
    const response = NextResponse.json({
      status: result.status,
      partial: result.partial,
      updatedAt: result.updatedAt,
      completedAt: result.completedAt,
      csrfToken: services.accountDeletion.receiptCsrfToken(result.receipt),
    });
    setAccountDeletionReceiptCookie(response, result.receipt, new Date(result.receiptExpiresAt));
    return noStore(response);
  } catch (error) {
    if (error instanceof AccountDeletionProofError) {
      return noStore(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
    }
    return noStore(NextResponse.json({ error: "unavailable" }, {
      status: 503,
      headers: { "Retry-After": "3" },
    }));
  }
}
