import type { NextRequest } from "next/server";
import { setPrimaryEmailRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return setPrimaryEmailRoute(request);
}
