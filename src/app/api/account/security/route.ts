import type { NextRequest } from "next/server";
import { securityRoute } from "@/server/security/routes";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return securityRoute(request);
}
