import type { NextRequest } from "next/server";
import { readInbox } from "@/server/inbox/http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return readInbox(request);
}
