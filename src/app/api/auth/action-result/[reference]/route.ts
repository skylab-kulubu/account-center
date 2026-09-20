import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";
import {
  noStore,
  SESSION_COOKIE,
  sessionMutationHasExactOrigin,
} from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";

export const dynamic = "force-dynamic";

function forbiddenResponse() {
  return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const services = getAuthServices();
  if (!sessionMutationHasExactOrigin(request, services.config)) return forbiddenResponse();

  const authorization = await services.sessionAccess.authenticateMutation(
    request.cookies.get(SESSION_COOKIE)?.value,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: false },
  );
  if (authorization.status === "forbidden") return forbiddenResponse();
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") return authenticationRequiredResponse();

  try {
    const { reference } = await params;
    await services.actionResults.consume(reference, authorization.value.session.id);
    return noStore(new NextResponse(null, { status: 204 }));
  } catch {
    return accountAccessUnavailableResponse();
  }
}
