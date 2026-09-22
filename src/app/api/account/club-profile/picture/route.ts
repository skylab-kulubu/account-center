import type { NextRequest } from "next/server";
import {
  removeClubProfilePicture,
  uploadClubProfilePicture,
} from "@/server/club-profile/http";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return uploadClubProfilePicture(request);
}

export function DELETE(request: NextRequest) {
  return removeClubProfilePicture(request);
}
