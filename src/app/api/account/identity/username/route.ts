import type { NextRequest } from "next/server";
import { changeUsernameRoute } from "@/server/identity/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return changeUsernameRoute(request);
}
