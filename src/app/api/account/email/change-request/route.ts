import type { NextRequest } from "next/server";
import { requestEmailChangeRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return requestEmailChangeRoute(request);
}
