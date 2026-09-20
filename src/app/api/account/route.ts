import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { noStore, SESSION_COOKIE } from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import {
  accountAccessUnavailableResponse,
  authenticationRequiredResponse,
} from "@/server/access-gate/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const services = getAuthServices();
  const handle = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = await services.sessionAccess.authenticate(handle);
  if (authorization.status === "unavailable") return accountAccessUnavailableResponse();
  if (authorization.status === "blocked") return authenticationRequiredResponse(true);
  if (authorization.status !== "active") {
    return noStore(NextResponse.json({
      type: "https://my.yildizskylab.com/problems/authentication-required",
      title: "Oturum açman gerekiyor",
      status: 401,
      detail: "Hesap bilgilerini görüntülemek için yeniden giriş yap.",
      instance: request.nextUrl.pathname,
    }, {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    }));
  }
  try {
    return noStore(NextResponse.json(
      await services.account.snapshot(authorization.value.session),
      { status: 200 },
    ));
  } catch (error) {
    const problem = toAccountProblem(error);
    return noStore(NextResponse.json(
      { ...problem, instance: request.nextUrl.pathname },
      {
        status: problem.status,
        headers: { "content-type": "application/problem+json" },
      },
    ));
  }
}
