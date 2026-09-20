// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/action/route";
import { OIDC_TRANSACTION_COOKIE, SESSION_COOKIE } from "@/server/auth/http";
import { InvalidAccountActionError } from "@/server/auth/oidc-flow";

const mocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  beginAccountAction: vi.fn(),
  createActionResult: vi.fn(),
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticateMutation: mocks.authenticateMutation },
    oidc: { beginAccountAction: mocks.beginAccountAction },
    actionResults: { create: mocks.createActionResult },
  }),
}));

const activeSession = {
  id: "d9a9bb4a-4977-4f07-8eb7-d3ba5c45e5cd",
  subject: "user-id",
  keycloakSid: "keycloak-session",
  createdAt: new Date("2026-09-20T10:00:00Z"),
  lastSeenAt: new Date("2026-09-20T11:00:00Z"),
  idleExpiresAt: new Date("2026-09-20T12:30:00Z"),
  absoluteExpiresAt: new Date("2026-09-20T18:00:00Z"),
};

function request(body: string, headers: Record<string, string> = {}) {
  return new NextRequest("https://my.yildizskylab.com/api/auth/action", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://my.yildizskylab.com",
      "sec-fetch-site": "same-origin",
      cookie: `${SESSION_COOKIE}=${"h".repeat(43)}`,
      ...headers,
    },
  });
}

describe("account action initiation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotated: false },
    });
    mocks.beginAccountAction.mockResolvedValue({
      authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3Aaction"),
      browserBinding: "b".repeat(43),
    });
    mocks.createActionResult.mockResolvedValue("r".repeat(43));
  });

  it("requires exact origin and session-bound CSRF before starting PAR", async () => {
    const crossOrigin = await POST(request("csrfToken=csrf&action=password", {
      origin: "https://evil.invalid",
      "sec-fetch-site": "cross-site",
    }));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.authenticateMutation).not.toHaveBeenCalled();

    mocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
    const invalidCsrf = await POST(request("csrfToken=wrong&action=password"));
    expect(invalidCsrf.status).toBe(403);
    expect(mocks.beginAccountAction).not.toHaveBeenCalled();
  });

  it("sets only secure host cookies and preserves a rotated opaque session", async () => {
    mocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotated: true, rotatedHandle: "n".repeat(43) },
    });
    const response = await POST(request("csrfToken=csrf&action=passkey"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("request_uri=urn%3Apar%3Aaction");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("b".repeat(43));
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
    expect(mocks.beginAccountAction).toHaveBeenCalledWith(
      { kind: "passkey" },
      activeSession,
    );
  });

  it("passes only an opaque deletion capability and rejects non-owned credentials", async () => {
    const capability = "c".repeat(43);
    await POST(request(`csrfToken=csrf&action=delete-credential&credential=${capability}`));
    expect(mocks.beginAccountAction).toHaveBeenCalledWith(
      { kind: "delete-credential", deletionReference: capability },
      activeSession,
    );

    mocks.beginAccountAction.mockRejectedValue(new InvalidAccountActionError());
    mocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotated: true, rotatedHandle: "n".repeat(43) },
    });
    const response = await POST(request("csrfToken=csrf&action=delete-credential&credential=forged"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
  });

  it("preserves a rotated session and creates a one-time error result when PAR fails", async () => {
    mocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotated: true, rotatedHandle: "n".repeat(43) },
    });
    mocks.beginAccountAction.mockRejectedValue(new Error("provider unavailable"));

    const response = await POST(request("csrfToken=csrf&action=otp"));

    expect(response.status).toBe(303);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
    expect(response.headers.get("location")).toBe(
      `https://my.yildizskylab.com/security?result=${"r".repeat(43)}`,
    );
    expect(mocks.createActionResult).toHaveBeenCalledWith(activeSession.id, {
      action: "otp",
      outcome: "error",
    });
  });

  it("fails closed for blocked or unavailable account access", async () => {
    mocks.authenticateMutation.mockResolvedValue({ status: "blocked" });
    const blocked = await POST(request("csrfToken=csrf&action=otp"));
    expect(blocked.status).toBe(401);
    expect(blocked.cookies.get(SESSION_COOKIE)?.value).toBe("");

    mocks.authenticateMutation.mockResolvedValue({ status: "unavailable" });
    const unavailable = await POST(request("csrfToken=csrf&action=otp"));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("3");
    expect(mocks.beginAccountAction).not.toHaveBeenCalled();
  });
});
