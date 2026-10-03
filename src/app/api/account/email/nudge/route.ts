import type { NextRequest } from "next/server";
import { primaryEmailNudgeRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return primaryEmailNudgeRoute(request);
}
