import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackRoute } from "@/app/api/auth/callback/route";
import { GET as loginRoute } from "@/app/api/auth/login/route";
import {
  EMBEDDED_APP_COOKIE,
  SESSION_COOKIE,
  OIDC_TRANSACTION_COOKIE,
} from "@/server/auth/http";
import { InvalidOidcTransactionError } from "@/server/auth/oidc-flow";
import {
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";
import { logAuthEvent } from "@/server/auth/logging";
import { OidcProviderStageError } from "@/server/auth/oidc-protocol";
import { UpstreamSessionExpiredError } from "@/server/auth/sessions";
import {
  SkyAccountContractError,
  SkyAccountProblem,
  SkyAccountUnavailableError,
} from "@/server/sky-account/client";
import type { SkyAccountProblemCode } from "@/server/sky-account/client";

const authMocks = vi.hoisted(() => ({
  begin: vi.fn(),
  callback: vi.fn(),
  revokeHandle: vi.fn(),
  rateLimitConsume: vi.fn(),
  storeReauthenticationProof: vi.fn(),
  storeSudo: vi.fn(),
  sudoAuthentication: vi.fn(),
  accessToken: vi.fn(),
  identity: vi.fn(),
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
    sudo: {
      storeReauthenticationProof: authMocks.storeReauthenticationProof,
      storeSudo: authMocks.storeSudo,
    },
    account: { accessToken: authMocks.accessToken },
    skyAccount: { identity: authMocks.identity, sudoAuthentication: authMocks.sudoAuthentication },
  }),
}));

const sudoSession = {
  id: "d9a9bb4a-4977-4f07-8eb7-d3ba5c45e5cd",
  subject: "fresh-user",
  keycloakSid: "fresh-sid",
  createdAt: new Date("2026-09-20T10:00:00Z"),
  lastSeenAt: new Date("2026-09-20T12:00:00Z"),
  idleExpiresAt: new Date("2026-09-20T12:30:00Z"),
  absoluteExpiresAt: new Date("2026-09-20T18:00:00Z"),
};
/** Stands in for the ID token of the forced login; only the server ever sees it. */
const freshIdToken = "eyJhbGciOiJSUzI1NiJ9.eyJ0eXAiOiJJRCJ9.fresh-login-signature";
const sudoGrant = {
  sudoToken: "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyJ9.sudo-signature",
  expiresAt: new Date("2026-09-20T12:05:00Z"),
};

function skyAccountProblem(code: SkyAccountProblemCode) {
  return new SkyAccountProblem({
    code,
    status: 401,
    detail: "Doğrulama kabul edilmedi.",
    retryAfter: null,
    field: null,
    policy: null,
    params: [],
    availableAt: null,
  });
}

/** A verified Microsoft return whose ID token the BFF may still turn into a sudo token. */
function seedSudoReauthentication() {
  authMocks.callback.mockResolvedValue({
    sudoReauthentication: "success",
    session: sudoSession,
    authenticatedAt: new Date("2026-09-20T12:00:00Z"),
    freshIdToken,
    returnTo: "/security",
  });
  authMocks.accessToken.mockResolvedValue("fresh-server-token");
  authMocks.sudoAuthentication.mockResolvedValue(sudoGrant);
  authMocks.storeSudo.mockResolvedValue(undefined);
  authMocks.storeReauthenticationProof.mockResolvedValue(true);
}

function sudoCallback() {
  return callbackRoute(new NextRequest(
    `https://my.yildizskylab.com/api/auth/callback?code=valid&state=${"s".repeat(43)}`,
    { headers: { cookie: `${SESSION_COOKIE}=${"h".repeat(43)}; ${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}` } },
  ));
}

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

  it("logs only the safe OIDC provider stage when callback processing fails", async () => {
    authMocks.callback.mockRejectedValue(
      new OidcProviderStageError("authorization_response"),
    );
    const request = new NextRequest(
      `https://my.yildizskylab.com/api/auth/callback?code=secret-code&state=${"s".repeat(43)}`,
      {
        headers: {
          cookie: `${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}`,
        },
      },
    );

    const response = await callbackRoute(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?error=unavailable",
    );
    expect(logAuthEvent).toHaveBeenCalledWith({
      event: "oidc_login_failed",
      requestId: "request-id",
      outcome: "failure",
      reason: "provider_unavailable",
      providerStage: "authorization_response",
    });
    expect(JSON.stringify(vi.mocked(logAuthEvent).mock.calls)).not.toContain("secret-code");
  });

  it("names an expired upstream session instead of blaming the provider", async () => {
    authMocks.callback.mockRejectedValue(new UpstreamSessionExpiredError());
    const request = new NextRequest(
      `https://my.yildizskylab.com/api/auth/callback?code=valid&state=${"s".repeat(43)}`,
      { headers: { cookie: `${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}` } },
    );

    const response = await callbackRoute(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?error=unavailable",
    );
    expect(logAuthEvent).toHaveBeenCalledWith({
      event: "oidc_login_failed",
      requestId: "request-id",
      outcome: "failure",
      reason: "upstream_session_expired",
    });
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

    // The flow logs a dropped session claim under this login's request id.
    expect(authMocks.callback.mock.calls[0]?.slice(1)).toEqual(["b".repeat(43), oldHandle, "request-id"]);
    expect(authMocks.revokeHandle).toHaveBeenCalledWith(oldHandle);
    expect(response.headers.get("location")).toBe("https://my.yildizskylab.com/security");
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(EMBEDDED_APP_COOKIE)).toBeUndefined();
  });

  it("marks a session the flow says opened inside SkyApp as embedded for exactly the session's lifetime", async () => {
    // Both cookies derive max-age from Date.now(); a frozen clock keeps them from straddling a second.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-20T12:00:00.250Z") });
    try {
      const absoluteExpiresAt = new Date("2026-09-20T20:00:00.000Z");
      authMocks.callback.mockResolvedValue({
        handle: "n".repeat(43),
        absoluteExpiresAt,
        returnTo: "/",
        embeddedApp: "skyapp",
      });

      const response = await callbackRoute(new NextRequest(
        `https://my.yildizskylab.com/api/auth/callback?code=valid&state=${"s".repeat(43)}`,
        { headers: { cookie: `${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}` } },
      ));

      expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
      const embedded = response.cookies.get(EMBEDDED_APP_COOKIE);
      expect(embedded?.value).toBe("skyapp");
      expect(embedded).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
      expect(embedded?.maxAge).toBe(response.cookies.get(SESSION_COOKIE)?.maxAge);
      expect(embedded?.maxAge).toBe(8 * 60 * 60 - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns the fresh Microsoft login into a sky-account sudo token and returns to the page", async () => {
    seedSudoReauthentication();
    const response = await sudoCallback();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=confirmed");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(authMocks.accessToken).toHaveBeenCalledWith(sudoSession);
    expect(authMocks.sudoAuthentication).toHaveBeenCalledWith(
      { accessToken: "fresh-server-token" },
      { idToken: freshIdToken },
    );
    expect(authMocks.storeSudo).toHaveBeenCalledWith(
      sudoSession.id,
      sudoGrant.sudoToken,
      sudoGrant.expiresAt,
      "reauth",
    );
    // The SPI answered, so no token-less proof is written.
    expect(authMocks.storeReauthenticationProof).not.toHaveBeenCalled();
    expect(authMocks.revokeHandle).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "sudo_reauthentication_completed",
      outcome: "success",
      sudoMethod: "reauth",
    }));
    expect(logAuthEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "sudo_authentication_failed" }));
    // Neither the ID token nor the sudo token may reach the browser or a log line.
    const exposed = [
      JSON.stringify([...response.headers]),
      await response.text(),
      JSON.stringify(vi.mocked(logAuthEvent).mock.calls),
    ].join("\n");
    expect(exposed).not.toContain(freshIdToken);
    expect(exposed).not.toContain(sudoGrant.sudoToken);
  });

  it.each([
    ["stale", () => skyAccountProblem("authentication_stale")],
    ["refused", () => skyAccountProblem("sudo_required")],
    ["unavailable", () => new SkyAccountUnavailableError()],
    ["contract", () => new SkyAccountContractError()],
  ])("keeps the token-less proof and logs %s when the sudo token cannot be issued", async (reason, failure) => {
    seedSudoReauthentication();
    authMocks.sudoAuthentication.mockRejectedValue(failure());
    const response = await sudoCallback();

    // The person is re-authenticated either way, so the page still hears `confirmed`.
    expect(response.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=confirmed");
    expect(authMocks.storeSudo).not.toHaveBeenCalled();
    expect(authMocks.storeReauthenticationProof)
      .toHaveBeenCalledWith(sudoSession.id, new Date("2026-09-20T12:00:00Z"));
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "sudo_authentication_failed",
      outcome: "failure",
      reason,
      sudoMethod: "reauth",
    }));
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "sudo_reauthentication_completed",
      outcome: "success",
      sudoMethod: "reauth",
    }));
    expect(JSON.stringify(vi.mocked(logAuthEvent).mock.calls)).not.toContain(freshIdToken);
  });

  it("falls back to the token-less proof when the grant cannot be stored, and gives up when neither can", async () => {
    seedSudoReauthentication();
    authMocks.storeSudo.mockRejectedValue(new Error("session gone"));
    const fallback = await sudoCallback();
    expect(fallback.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=confirmed");
    expect(authMocks.storeReauthenticationProof).toHaveBeenCalledTimes(1);

    authMocks.storeReauthenticationProof.mockRejectedValue(new Error("session gone"));
    const failed = await sudoCallback();
    expect(failed.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=unavailable");
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "sudo_reauthentication_completed",
      outcome: "failure",
      reason: "sudo_storage_failed",
      sudoMethod: "reauth",
    }));
  });

  it("returns a cancelled Microsoft re-authentication without proving anything", async () => {
    seedSudoReauthentication();
    authMocks.callback.mockResolvedValue({ sudoReauthentication: "cancelled", returnTo: "/security" });
    const cancelled = await callbackRoute(new NextRequest(
      `https://my.yildizskylab.com/api/auth/callback?error=access_denied&state=${"s".repeat(43)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${"h".repeat(43)}; ${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}` } },
    ));
    expect(cancelled.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=cancelled");
    expect(authMocks.sudoAuthentication).not.toHaveBeenCalled();
    expect(authMocks.storeSudo).not.toHaveBeenCalled();
    expect(authMocks.storeReauthenticationProof).not.toHaveBeenCalled();
  });

  it("returns the YTÜ link outcome to the identity page only after re-reading the identity", async () => {
    const activeSession = {
      id: "d9a9bb4a-4977-4f07-8eb7-d3ba5c45e5cd",
      subject: "linking-user",
      keycloakSid: "rotated-sid",
      createdAt: new Date("2026-09-22T08:00:00Z"),
      lastSeenAt: new Date("2026-09-22T09:00:00Z"),
      idleExpiresAt: new Date("2026-09-22T09:30:00Z"),
      absoluteExpiresAt: new Date("2026-09-22T16:00:00Z"),
    };
    const callback = (query: string) => callbackRoute(new NextRequest(
      `https://my.yildizskylab.com/api/auth/callback?${query}&state=${"s".repeat(43)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${"h".repeat(43)}; ${OIDC_TRANSACTION_COOKIE}=${"b".repeat(43)}` } },
    ));
    authMocks.callback.mockResolvedValue({ ytuLink: "success", session: activeSession, returnTo: "/identity" });
    authMocks.accessToken.mockResolvedValue("fresh-server-token");
    authMocks.identity.mockResolvedValue({ verifiedYtu: true });

    const linked = await callback("code=valid&kc_action=idp_link&kc_action_status=success");
    expect(linked.status).toBe(303);
    expect(linked.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=linked");
    expect(linked.headers.get("referrer-policy")).toBe("no-referrer");
    expect(linked.headers.get("cache-control")).toBe("no-store");
    expect(linked.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("");
    expect(linked.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(linked.headers.get("set-cookie")).not.toContain("fresh-server-token");
    expect(authMocks.accessToken).toHaveBeenCalledWith(activeSession);
    expect(authMocks.identity).toHaveBeenCalledWith({ accessToken: "fresh-server-token" });
    expect(authMocks.revokeHandle).not.toHaveBeenCalled();
    expect(authMocks.storeReauthenticationProof).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_completed", outcome: "success" }));

    authMocks.identity.mockResolvedValue({ verifiedYtu: false });
    const unverified = await callback("code=valid&kc_action=idp_link&kc_action_status=success");
    expect(unverified.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=unverified");
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_completed", reason: "link_unverified" }));

    authMocks.callback.mockResolvedValue({ ytuLink: "cancelled", session: activeSession, returnTo: "/identity" });
    const cancelled = await callback("code=valid&kc_action=idp_link&kc_action_status=cancelled");
    expect(cancelled.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=cancelled");
    authMocks.callback.mockResolvedValue({ ytuLink: "error", session: activeSession, returnTo: "/identity" });
    const failed = await callback("code=valid&kc_action=idp_link&kc_action_status=error");
    expect(failed.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=error");
    expect(failed.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("");
    expect(authMocks.identity).toHaveBeenCalledTimes(2);
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
