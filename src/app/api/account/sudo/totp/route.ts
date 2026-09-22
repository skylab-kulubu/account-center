import type { NextRequest } from "next/server";
import { sudoProofRoute } from "@/server/auth/sudo-routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return sudoProofRoute(request, "totp");
}
