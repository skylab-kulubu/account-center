import type { NextRequest } from "next/server";
import {
  grantPromotionalConsent,
  withdrawPromotionalConsent,
} from "@/server/promotional-consent/http";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return grantPromotionalConsent(request);
}

export function DELETE(request: NextRequest) {
  return withdrawPromotionalConsent(request);
}
