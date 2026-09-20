import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as handoffRoute } from "@/app/handoff/route";
import { POST as createRoute } from "@/app/v1/native-handoff/route";
import { OIDC_TRANSACTION_COOKIE } from "@/server/auth/http";
import { InvalidNativeHandoffError } from "@/server/auth/native-handoff";
import { InvalidNativeAccessTokenError } from "@/server/auth/native-handoff-token";
import {
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  consume: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    nativeHandoff: { create: mocks.create, consume: mocks.consume },
    anonymousRateLimit: { consume: mocks.rateLimit },
  }),
}));

describe("native handoff public routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
  });

  it("creates a handoff for an originless native Bearer request without accepting a body", async () => {
    mocks.create.mockResolvedValue({
      handoffUrl: `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}`,
      expiresIn: 45,
    });
    const response = await createRoute(new NextRequest("https://my.yildizskylab.com/v1/native-handoff", {
      method: "POST",
      headers: {
        authorization: "Bearer header.payload.signature",
        "cf-connecting-ip": "203.0.113.4",
      },
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      handoffUrl: `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}`,
      expiresIn: 45,
    });
    expect(mocks.create).toHaveBeenCalledWith("header.payload.signature");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects cross-origin, malformed Bearer and non-empty requests before creating a code", async () => {
    const crossOrigin = await createRoute(new NextRequest("https://my.yildizskylab.com/v1/native-handoff", {
      method: "POST",
      headers: {
        authorization: "Bearer header.payload.signature",
        origin: "https://attacker.invalid",
        "sec-fetch-site": "cross-site",
      },
    }));
    const malformed = await createRoute(new NextRequest("https://my.yildizskylab.com/v1/native-handoff", {
      method: "POST",
      headers: { authorization: "Basic secret" },
    }));
    const nonCanonicalOrigin = await createRoute(new NextRequest("https://my.yildizskylab.com/v1/native-handoff", {
      method: "POST",
      headers: {
        authorization: "Bearer header.payload.signature",
        origin: "https://my.yildizskylab.com/path",
        "sec-fetch-site": "same-origin",
      },
    }));
    const body = await createRoute(new NextRequest("https://my.yildizskylab.com/v1/native-handoff", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
      body: "{}",
    }));

    expect(crossOrigin.status).toBe(403);
    expect(malformed.status).toBe(401);
    expect(nonCanonicalOrigin.status).toBe(403);
    expect(body.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns the same redacted unauthorized response for invalid tokens", async () => {
    mocks.create.mockRejectedValue(new InvalidNativeAccessTokenError());
    const response = await createRoute(new NextRequest("https://my.yildizskylab.com/v1/native-handoff", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
    }));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "invalid_token" });
    expect(JSON.stringify(body)).not.toContain("header.payload.signature");
  });

  it("accepts either a true native request or an exact browser origin/site pair", async () => {
    mocks.create.mockResolvedValue({
      handoffUrl: `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}`,
      expiresIn: 45,
    });
    const bearer = { authorization: "Bearer header.payload.signature" };
    const browser = await createRoute(new NextRequest(
      "https://my.yildizskylab.com/v1/native-handoff",
      {
        method: "POST",
        headers: {
          ...bearer,
          origin: "https://my.yildizskylab.com",
          "sec-fetch-site": "same-origin",
        },
      },
    ));
    const originOnly = await createRoute(new NextRequest(
      "https://my.yildizskylab.com/v1/native-handoff",
      { method: "POST", headers: { ...bearer, origin: "https://my.yildizskylab.com" } },
    ));
    const siteOnly = await createRoute(new NextRequest(
      "https://my.yildizskylab.com/v1/native-handoff",
      { method: "POST", headers: { ...bearer, "sec-fetch-site": "same-origin" } },
    ));
    const browserNavigationOnly = await createRoute(new NextRequest(
      "https://my.yildizskylab.com/v1/native-handoff",
      { method: "POST", headers: { ...bearer, "sec-fetch-site": "none" } },
    ));

    expect(browser.status).toBe(201);
    expect(originOnly.status).toBe(403);
    expect(siteOnly.status).toBe(403);
    expect(browserNavigationOnly.status).toBe(403);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("atomically consumes a public code, sets only the transaction cookie and redirects to PAR", async () => {
    mocks.consume.mockResolvedValue({
      authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3A1"),
      browserBinding: "b".repeat(43),
    });
    const response = await handoffRoute(new NextRequest(
      `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}`,
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("request_uri=urn%3Apar%3A1");
    expect(response.headers.get("location")).not.toContain("p".repeat(43));
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("b".repeat(43));
    expect(mocks.consume).toHaveBeenCalledWith("p".repeat(43));
  });

  it("uses a fixed same-origin failure redirect for replayed, expired or duplicate codes", async () => {
    mocks.consume.mockRejectedValue(new InvalidNativeHandoffError());
    const replay = await handoffRoute(new NextRequest(
      `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}&returnTo=https://attacker.invalid`,
    ));
    const duplicate = await handoffRoute(new NextRequest(
      `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}&code=${"q".repeat(43)}`,
    ));

    expect(replay.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?error=invalid_request",
    );
    expect(duplicate.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?error=invalid_request",
    );
    expect(replay.headers.get("referrer-policy")).toBe("no-referrer");
    expect(duplicate.headers.get("referrer-policy")).toBe("no-referrer");
    expect(replay.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
  });

  it("maps blocked native identity to the same generic invalid-token response", async () => {
    mocks.create.mockRejectedValue(new AccountAccessBlockedError());

    const response = await createRoute(new NextRequest(
      "https://my.yildizskylab.com/v1/native-handoff",
      {
        method: "POST",
        headers: { authorization: "Bearer header.payload.signature" },
      },
    ));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_token" });
  });

  it("returns retryable 503 without creating or consuming state when the gate is unavailable", async () => {
    mocks.create.mockRejectedValue(new AccountAccessUnavailableError());
    const create = await createRoute(new NextRequest(
      "https://my.yildizskylab.com/v1/native-handoff",
      {
        method: "POST",
        headers: { authorization: "Bearer header.payload.signature" },
      },
    ));
    mocks.consume.mockRejectedValue(new AccountAccessUnavailableError());
    const consume = await handoffRoute(new NextRequest(
      `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}`,
    ));

    for (const response of [create, consume]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("3");
    }
    expect(consume.headers.get("referrer-policy")).toBe("no-referrer");
    expect(consume.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
  });
});
