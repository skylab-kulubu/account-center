import type { NextRequest } from "next/server";
import { sudoReauthenticateRoute } from "@/server/auth/sudo-routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return sudoReauthenticateRoute(request);
}
