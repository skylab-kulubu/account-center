// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "@/app/api/account/skypass/wallet/google/route";
import { SESSION_COOKIE } from "@/server/auth/http";
import { CoreSkyPassWalletError } from "@/server/core/skypass-wallet-client";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";

const saveUrl = "https://pay.google.com/gp/v/save/eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJza3lsYWIifQ.c2lnbmF0dXJl";

const routeMocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  revokeLocalSession: vi.fn(),
  accessToken: vi.fn(),
  status: vi.fn(),
  googleSaveUrl: vi.fn(),
  revokeGoogle: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => routeMocks.services,
}));

const activeSession = {
  id: "local-session-id",
  subject: "authenticated-subject",
  absoluteExpiresAt: new Date("2026-10-09T20:00:00Z"),
};

function buildServices(options: { coreEnabled?: boolean } = {}) {
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticateMutation: routeMocks.authenticateMutation },
    sessions: { revokeSession: routeMocks.revokeLocalSession },
    account: { accessToken: routeMocks.accessToken },
    coreSkyPassWallet: options.coreEnabled === false
      ? null
      : { status: routeMocks.status, googleSaveUrl: routeMocks.googleSaveUrl, revokeGoogle: routeMocks.revokeGoogle },
  };
}

function request(method: "POST" | "DELETE", options: { origin?: string | null; csrf?: string } = {}) {
  const headers = new Headers({ cookie: "__Host-sky-account=opaque-browser-handle" });
  const origin = options.origin === undefined ? "https://my.yildizskylab.com" : options.origin;
  if (origin) {
    headers.set("origin", origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  headers.set("x-csrf-token", options.csrf ?? "session-bound-csrf");
  return new NextRequest("https://my.yildizskylab.com/api/account/skypass/wallet/google", { method, headers });
}

const logged = vi.fn();

describe("SkyPass Google Wallet BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.services = buildServices();
    routeMocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession } });
    routeMocks.revokeLocalSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.googleSaveUrl.mockResolvedValue(saveUrl);
    routeMocks.revokeGoogle.mockResolvedValue(undefined);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(logged);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it("answers the save link, uncached, to the browser that asked and logs nothing", async () => {
    const response = await POST(request("POST"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ saveUrl });
    expect(routeMocks.googleSaveUrl).toHaveBeenCalledWith("server-held-user-token");
    expect(routeMocks.authenticateMutation).toHaveBeenCalledWith(
      "opaque-browser-handle",
      "session-bound-csrf",
      { allowRotation: true },
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it("ends the pass with 204", async () => {
    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(routeMocks.revokeGoogle).toHaveBeenCalledWith("server-held-user-token");
  });

  it("refuses a cross-site or origin-less write before authenticating", async () => {
    for (const origin of ["https://attacker.invalid", null]) {
      for (const handler of [POST, DELETE]) {
        const response = await handler(request(handler === POST ? "POST" : "DELETE", { origin }));
        expect(response.status).toBe(403);
      }
    }
    expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();
    expect(routeMocks.googleSaveUrl).not.toHaveBeenCalled();
  });

  it("refuses a write without the session-bound CSRF proof", async () => {
    routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });

    const response = await POST(request("POST", { csrf: "wrong" }));

    expect(response.status).toBe(403);
    expect(routeMocks.googleSaveUrl).not.toHaveBeenCalled();
  });

  it("reports Google Wallet as off when CORE_API_URL is unset", async () => {
    routeMocks.services = buildServices({ coreEnabled: false });

    const response = await POST(request("POST"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "skypass_google_wallet_off" });
  });

  it.each([
    [new CoreSkyPassWalletError("off"), 503, "skypass_google_wallet_off", null],
    [new CoreSkyPassWalletError("ended"), 409, "skypass_wallet_pass_ended", null],
    [new CoreSkyPassWalletError("rate_limited", 42), 429, "skypass_wallet_rate_limited", "42"],
    [new CoreSkyPassWalletError("google_unavailable", 30), 502, "skypass_google_wallet_unavailable", "30"],
  ])("maps %s to a problem with its code", async (error, status, code, retryAfter) => {
    routeMocks.googleSaveUrl.mockRejectedValue(error);

    const response = await POST(request("POST"));

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("retry-after")).toBe(retryAfter);
    const body = await response.json();
    expect(body).toMatchObject({ code, status, instance: "/api/account/skypass/wallet/google" });
    if (retryAfter) expect(body.retryAfterSeconds).toBe(Number(retryAfter));
    expect(routeMocks.revokeLocalSession).not.toHaveBeenCalled();
  });

  it("retries once with a refreshed token on a core 401 and keeps the local session if core still refuses", async () => {
    routeMocks.googleSaveUrl.mockRejectedValue(new CoreSkyPassWalletError("unauthorized"));

    const response = await POST(request("POST"));

    expect(response.status).toBe(401);
    expect(routeMocks.accessToken).toHaveBeenNthCalledWith(2, activeSession, { forceRefresh: true });
    expect(routeMocks.googleSaveUrl).toHaveBeenCalledTimes(2);
    expect(routeMocks.revokeLocalSession).not.toHaveBeenCalled();
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("ends the local session when the Keycloak token cannot be refreshed", async () => {
    routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());

    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(401);
    expect(routeMocks.revokeLocalSession).toHaveBeenCalledWith(activeSession.id);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(routeMocks.revokeGoogle).not.toHaveBeenCalled();
  });

  it("carries a rotated session handle on success and failure", async () => {
    routeMocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotatedHandle: "rotated-handle" },
    });

    expect((await POST(request("POST"))).cookies.get(SESSION_COOKIE)?.value).toBe("rotated-handle");
    routeMocks.revokeGoogle.mockRejectedValue(new CoreSkyPassWalletError("unavailable"));
    const failed = await DELETE(request("DELETE"));
    expect(failed.status).toBe(503);
    expect(failed.cookies.get(SESSION_COOKIE)?.value).toBe("rotated-handle");
  });
});
