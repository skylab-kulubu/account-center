import type { NextRequest } from "next/server";
import {
  grantTeamPageConsent,
  withdrawTeamPageConsent,
} from "@/server/team-page-consent/http";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return grantTeamPageConsent(request);
}

export function DELETE(request: NextRequest) {
  return withdrawTeamPageConsent(request);
}
