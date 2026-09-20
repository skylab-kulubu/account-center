import "server-only";

import { NextResponse } from "next/server";
import { clearSessionCookie, noStore } from "@/server/auth/http";

export const ACCOUNT_ACCESS_RETRY_AFTER_SECONDS = 3;

export function accountAccessUnavailableResponse() {
  const response = NextResponse.json(
    { error: "temporarily_unavailable" },
    { status: 503 },
  );
  response.headers.set("Retry-After", String(ACCOUNT_ACCESS_RETRY_AFTER_SECONDS));
  return noStore(response);
}

export function authenticationRequiredResponse(clearCookie = false) {
  const response = NextResponse.json(
    { error: "authentication_required" },
    { status: 401 },
  );
  if (clearCookie) clearSessionCookie(response);
  return noStore(response);
}
