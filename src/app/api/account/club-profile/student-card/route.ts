import type { NextRequest } from "next/server";
import { removeClubProfileStudentCard } from "@/server/club-profile/http";

export const dynamic = "force-dynamic";

export function DELETE(request: NextRequest) {
  return removeClubProfileStudentCard(request);
}
