import type { NextRequest } from "next/server";
import { sudoMethodsRoute } from "@/server/auth/sudo-routes";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return sudoMethodsRoute(request);
}
