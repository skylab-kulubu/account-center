import type { NextRequest } from "next/server";
import { promotionalSignupOfferRoute } from "@/server/promotional-consent/http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return promotionalSignupOfferRoute(request);
}
