import type { NextRequest } from "next/server";
import { createGoogleWalletLink, revokeGoogleWalletPass } from "@/server/skypass-wallet/http";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return createGoogleWalletLink(request);
}

export function DELETE(request: NextRequest) {
  return revokeGoogleWalletPass(request);
}
