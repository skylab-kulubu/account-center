import type { NextRequest } from "next/server";
import { readClubProfile, updateClubProfile } from "@/server/club-profile/http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return readClubProfile(request);
}

export function PATCH(request: NextRequest) {
  return updateClubProfile(request);
}
