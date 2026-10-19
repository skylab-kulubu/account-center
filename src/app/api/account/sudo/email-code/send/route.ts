import type { NextRequest } from "next/server";
import { sudoEmailCodeSendRoute } from "@/server/auth/sudo-routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return sudoEmailCodeSendRoute(request);
}
