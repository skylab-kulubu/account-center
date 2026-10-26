import type { NextRequest } from "next/server";
import { markInboxItem } from "@/server/inbox/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  return markInboxItem(request, id, action);
}
