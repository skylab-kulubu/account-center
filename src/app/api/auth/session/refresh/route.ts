import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { mutationHasExactOrigin, noStore, SESSION_COOKIE, setSessionCookie } from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const services = getAuthServices();
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  if (!mutationHasExactOrigin(request, services.config)) {
    return noStore(new NextResponse(null, { status: 403 }));
  }
  const authorization = await services.sessions.authenticateMutation(
    handle,
    request.headers.get("x-csrf-token") ?? undefined,
    { allowRotation: true },
  );
  if (authorization.status === "forbidden") return noStore(new NextResponse(null, { status: 403 }));
  if (authorization.status === "missing") return noStore(new NextResponse(null, { status: 401 }));
  const refreshed = authorization.value;
  const response = new NextResponse(null, { status: 204 });
  if (refreshed.rotatedHandle) {
    setSessionCookie(response, refreshed.rotatedHandle, refreshed.session.absoluteExpiresAt);
  }
  return noStore(response);
}
