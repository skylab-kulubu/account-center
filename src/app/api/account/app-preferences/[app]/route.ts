import type { NextRequest } from "next/server";
import { resetAppPreferences } from "@/server/app-preferences/http";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ app: string }> },
) {
  const { app } = await params;
  return resetAppPreferences(request, app);
}
