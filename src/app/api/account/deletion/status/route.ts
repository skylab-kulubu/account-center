import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ACCOUNT_DELETION_RECEIPT_COOKIE,
  clearAccountDeletionReceiptCookie,
  noStore,
  setAccountDeletionReceiptCookie,
} from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";
import { accountDeletionErrorKind } from "@/server/account-deletion/orchestrator";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const services = getAuthServices();
  if (!services.accountDeletion) {
    return noStore(NextResponse.json({ error: "unavailable" }, {
      status: 503,
      headers: { "Retry-After": "60" },
    }));
  }
  const receipt = request.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)?.value;
  if (!receipt) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  try {
    const result = await services.accountDeletion.status(receipt);
    if (!result || !result.receiptExpiresAt) {
      const response = NextResponse.json({ error: "not_found" }, { status: 404 });
      clearAccountDeletionReceiptCookie(response);
      return noStore(response);
    }
    const csrfToken = services.accountDeletion.receiptCsrfToken(result.receipt);
    const response = NextResponse.json({
      status: result.status,
      partial: result.partial,
      updatedAt: result.updatedAt,
      completedAt: result.completedAt,
      csrfToken,
    });
    setAccountDeletionReceiptCookie(response, result.receipt, new Date(result.receiptExpiresAt));
    return noStore(response);
  } catch (error) {
    // Core refused the sealed credentials on a recovery replay: the request
    // may be under way and asking again cannot tell. The receipt cookie is
    // kept; it is the only handle on the intent and expires with it.
    if (accountDeletionErrorKind(error) === "outcome_unknown") {
      return noStore(NextResponse.json({ error: "outcome_unknown" }, { status: 409 }));
    }
    return noStore(NextResponse.json({ error: "unavailable" }, {
      status: 503,
      headers: { "Retry-After": "3" },
    }));
  }
}
