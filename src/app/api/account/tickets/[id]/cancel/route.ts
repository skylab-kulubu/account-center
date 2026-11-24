import type { NextRequest } from "next/server";
import { cancelTicket } from "@/server/tickets/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return cancelTicket(request, id);
}
