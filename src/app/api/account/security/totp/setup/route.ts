import type { NextRequest } from "next/server";
import { totpSetupRoute } from "@/server/security/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return totpSetupRoute(request);
}
