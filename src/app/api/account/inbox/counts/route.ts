import type { NextRequest } from "next/server";
import { readInboxCounts } from "@/server/inbox/http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return readInboxCounts(request);
}
