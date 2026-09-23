import type { NextRequest } from "next/server";
import { emailRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return emailRoute(request);
}
