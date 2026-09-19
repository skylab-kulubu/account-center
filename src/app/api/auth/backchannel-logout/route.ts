import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  BackchannelLogoutReplayError,
  InvalidBackchannelLogoutError,
} from "@/server/auth/backchannel-logout";
import { noStore } from "@/server/auth/http";
import { logAuthEvent, requestCorrelationId } from "@/server/auth/logging";
import { readUrlEncodedBody, RequestBodyError } from "@/server/auth/request-body";
import { getAuthServices } from "@/server/auth/services";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = requestCorrelationId(request);
  let parameters: URLSearchParams;
  try {
    parameters = await readUrlEncodedBody(request, { maxBytes: 16_384 });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }
  const logoutTokens = parameters.getAll("logout_token");
  if (logoutTokens.length !== 1 || !logoutTokens[0]) {
    return noStore(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  }

  try {
    await getAuthServices().backchannelLogout.consume(logoutTokens[0]);
    logAuthEvent({ event: "backchannel_logout", requestId, outcome: "success" });
    return noStore(new NextResponse(null, { status: 200 }));
  } catch (error) {
    logAuthEvent({
      event: "backchannel_logout",
      requestId,
      outcome: "failure",
      reason:
        error instanceof BackchannelLogoutReplayError
          ? "replayed_logout_token"
          : "invalid_logout_token",
    });
    const status = error instanceof InvalidBackchannelLogoutError ||
      error instanceof BackchannelLogoutReplayError
      ? 400
      : 503;
    return noStore(NextResponse.json({ error: "invalid_request" }, { status }));
  }
}
