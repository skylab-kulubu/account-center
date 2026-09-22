import type { NextRequest } from "next/server";
import { changeNameRoute } from "@/server/identity/routes";

export const dynamic = "force-dynamic";

export function PATCH(request: NextRequest) {
  return changeNameRoute(request);
}
