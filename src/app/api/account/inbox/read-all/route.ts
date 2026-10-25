import type { NextRequest } from "next/server";
import { markAllInbox } from "@/server/inbox/http";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return markAllInbox(request, "read-all");
}
