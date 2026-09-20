import type { NextRequest } from "next/server";
import { revokeManagedSessions } from "@/server/keycloak-account/session-http";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const { reference } = await params;
  return revokeManagedSessions(
    request,
    (services, session) => services.account.revokeOtherSession(session, reference),
  );
}
