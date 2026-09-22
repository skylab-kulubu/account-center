import type { NextRequest } from "next/server";
import { changePasswordRoute } from "@/server/security/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return changePasswordRoute(request);
}
