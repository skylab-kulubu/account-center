import type { NextRequest } from "next/server";
import { identityRoute } from "@/server/identity/routes";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return identityRoute(request);
}
