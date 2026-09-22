import type { NextRequest } from "next/server";
import { passkeyRegisterRoute } from "@/server/security/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return passkeyRegisterRoute(request);
}
