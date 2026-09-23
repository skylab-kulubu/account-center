import type { NextRequest } from "next/server";
import { confirmEmailRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return confirmEmailRoute(request);
}
