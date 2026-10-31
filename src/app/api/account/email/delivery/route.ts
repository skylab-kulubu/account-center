import type { NextRequest } from "next/server";
import { emailDeliveryRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return emailDeliveryRoute(request);
}
