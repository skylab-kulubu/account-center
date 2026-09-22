import type { NextRequest } from "next/server";
import { deleteCredentialRoute } from "@/server/security/routes";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const { reference } = await params;
  return deleteCredentialRoute(request, reference);
}
