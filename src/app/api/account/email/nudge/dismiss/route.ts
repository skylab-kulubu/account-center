import type { NextRequest } from "next/server";
import { dismissPrimaryEmailNudgeRoute } from "@/server/email/routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return dismissPrimaryEmailNudgeRoute(request);
}
