import { NextResponse } from "next/server";
import { clearSessionCookie, noStore } from "@/server/auth/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/login?sessionEnded=1", request.url), 303);
  clearSessionCookie(response);
  return noStore(response);
}
