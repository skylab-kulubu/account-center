import type { NextRequest } from "next/server";
import { removePersonalEmailRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function DELETE(request: NextRequest) {
  return removePersonalEmailRoute(request);
}
