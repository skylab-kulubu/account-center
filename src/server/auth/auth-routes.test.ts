import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackRoute } from "@/app/api/auth/callback/route";
import { GET as loginRoute } from "@/app/api/auth/login/route";
import { SESSION_COOKIE, OIDC_TRANSACTION_COOKIE } from "@/server/auth/http";
import { InvalidOidcTransactionError } from "@/server/auth/oidc-flow";
import {
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";

const authMocks = vi.hoisted(() => ({
  begin: vi.fn(),
  callback: vi.fn(),
  revokeHandle: vi.fn(),
  rateLimitConsume: vi.fn(),
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    oidc: { begin: authMocks.begin, callback: authMocks.callback },
    sessions: { revokeHandle: authMocks.revokeHandle },
    anonymousRateLimit: { consume: authMocks.rateLimitConsume },
  }),
}));

describe("authentication routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.rateLimitConsume.mockResolvedValue({
      allowed: true,
      count: 1,
      retryAfterSeconds: 60,
    });
  });

  it("returns a retryable 429 before anonymous login or callback work", async () => {
    authMocks.rateLimitConsume.mockResolvedValue({
      allowed: false,
      count: 11,
      retryAfterSeconds: 18,
    });
    const loginResponse = await loginRoute(
      new NextRequest("https://my.yildizskylab.com/api/auth/login"),
    );
    const callbackResponse = await callbackRoute(
      new NextRequest(`https://my.yildizskylab.com/api/auth/callback?state=${"s".repeat(43)}`, {
        headers: {
          cookie: `${SESSION_COOKIE}=${"h".repeat(43)}; ${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}`,
        },
      }),
    );

    expect(loginResponse.status).toBe(429);
    expect(loginResponse.headers.get("retry-after")).toBe("18");
    expect(callbackResponse.status).toBe(429);
    expect(callbackResponse.headers.get("retry-after")).toBe("18");
    expect(callbackResponse.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(callbackResponse.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
    expect(authMocks.begin).not.toHaveBeenCalled();
    expect(authMocks.callback).not.toHaveBeenCalled();
  });

  it("binds a login transaction to a secure host-only browser cookie", async () => {
    authMocks.begin.mockResolvedValue({
      authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?request_uri=urn%3Apar%3A1"),
      browserBinding: "b".repeat(43),
    });

    const response = await loginRoute(
      new NextRequest("https://my.yildizskylab.com/api/auth/login?returnTo=%2Fsecurity"),
    );

    expect(response.status).toBe(303);
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("b".repeat(43));
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${OIDC_TRANSACTION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
  });

  it("preserves an existing valid session when an invalid callback is opened", async () => {
    authMocks.callback.mockRejectedValue(new InvalidOidcTransactionError());
    const request = new NextRequest(
      "https://my.yildizskylab.com/api/auth/callback?code=invalid&state=s".concat("s".repeat(42)),
      {
        headers: {
          cookie: `${SESSION_COOKIE}=${"h".repeat(43)}; ${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}`,
        },
      },
    );

    const response = await callbackRoute(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?error=invalid_request",
    );
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("");
    expect(authMocks.revokeHandle).not.toHaveBeenCalled();
  });

  it("replaces the old local session only after a successful callback", async () => {
    const absoluteExpiresAt = new Date("2026-09-20T08:00:00Z");
    authMocks.callback.mockResolvedValue({
      handle: "n".repeat(43),
      absoluteExpiresAt,
      returnTo: "/security",
    });
    const oldHandle = "h".repeat(43);
    const request = new NextRequest(
      `https://my.yildizskylab.com/api/auth/callback?code=valid&state=${"s".repeat(43)}`,
      {
        headers: {
          cookie: `${SESSION_COOKIE}=${oldHandle}; ${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}`,
        },
      },
    );

    const response = await callbackRoute(request);

    expect(authMocks.revokeHandle).toHaveBeenCalledWith(oldHandle);
    expect(response.headers.get("location")).toBe("https://my.yildizskylab.com/security");
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("");
  });

  it("clears stale cookies without disclosing why a verified subject is denied", async () => {
    authMocks.callback.mockRejectedValue(new AccountAccessBlockedError());
    const response = await callbackRoute(new NextRequest(
      `https://my.yildizskylab.com/api/auth/callback?code=valid&state=${"s".repeat(43)}`,
      {
        headers: {
          cookie: `${SESSION_COOKIE}=${"h".repeat(43)}; ${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}`,
        },
      },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?sessionEnded=1",
    );
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("");
  });

  it("returns a retryable no-store 503 when access cannot be proven", async () => {
    authMocks.callback.mockRejectedValue(new AccountAccessUnavailableError());
    const response = await callbackRoute(new NextRequest(
      `https://my.yildizskylab.com/api/auth/callback?code=valid&state=${"s".repeat(43)}`,
      { headers: { cookie: `${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}` } },
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});
