import type { NextRequest } from "next/server";
import { pendingEmailChangeRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return pendingEmailChangeRoute(request);
}
