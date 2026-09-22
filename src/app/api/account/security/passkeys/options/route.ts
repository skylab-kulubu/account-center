import type { NextRequest } from "next/server";
import { passkeyOptionsRoute } from "@/server/security/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return passkeyOptionsRoute(request);
}
