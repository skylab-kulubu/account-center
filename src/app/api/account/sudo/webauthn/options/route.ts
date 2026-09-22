import type { NextRequest } from "next/server";
import { sudoWebauthnOptionsRoute } from "@/server/auth/sudo-routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return sudoWebauthnOptionsRoute(request);
}
