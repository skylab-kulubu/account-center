import type { NextRequest } from "next/server";
import { startYtuLinkRoute } from "@/server/identity/ytu-link";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return startYtuLinkRoute(request);
}
