import type { NextRequest } from "next/server";
import { totpConfirmRoute } from "@/server/security/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return totpConfirmRoute(request);
}
