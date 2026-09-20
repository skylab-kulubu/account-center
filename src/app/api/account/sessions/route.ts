import type { NextRequest } from "next/server";
import {
  listManagedSessions,
  revokeManagedSessions,
} from "@/server/keycloak-account/session-http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return listManagedSessions(request);
}

export function DELETE(request: NextRequest) {
  return revokeManagedSessions(
    request,
    (services, session) => services.account.revokeOtherSessions(session),
  );
}
