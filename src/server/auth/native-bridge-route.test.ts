import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/internal/v1/native-handoff/redeem/route";
import { InvalidNativeBridgeRequestError } from "@/server/auth/native-bridge-auth";
import { InvalidNativeHandoffError } from "@/server/auth/native-handoff";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  redeem: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    nativeBridgeRequest: { verify: mocks.verify },
    nativeHandoff: { redeem: mocks.redeem },
    anonymousRateLimit: { consumeKey: mocks.rateLimit },
  }),
}));

function request(
  body = JSON.stringify({ code: "b".repeat(43) }),
  url = "https://my.yildizskylab.com/internal/v1/native-handoff/redeem",
) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("native bridge redemption route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue({
      requestNonceHash: Buffer.alloc(32, 1),
      requestNonceExpiresAt: new Date("2026-09-20T12:01:00Z"),
    });
    mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
  });

  it("returns only the claims required by the Keycloak authenticator", async () => {
    mocks.redeem.mockResolvedValue({
      subject: "user-id",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sub: "user-id",
      sid: "native-session",
      auth_time: 1_789_904_700,
    });
    expect(mocks.redeem).toHaveBeenCalledWith("b".repeat(43), {
      requestNonceHash: Buffer.alloc(32, 1),
      requestNonceExpiresAt: new Date("2026-09-20T12:01:00Z"),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing mTLS or a bad HMAC before persistence", async () => {
    mocks.verify.mockImplementation(() => {
      throw new InvalidNativeBridgeRequestError();
    });

    const response = await POST(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, extra fields and bridge replays with one redacted error", async () => {
    const malformed = await POST(request("{"));
    const extra = await POST(request(JSON.stringify({ code: "b".repeat(43), sub: "leak" })));
    mocks.redeem.mockRejectedValue(new InvalidNativeHandoffError());
    const replay = await POST(request());

    expect(malformed.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rate limits the authenticated Keycloak client before bridge redemption", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it("requires the exact JSON media type before HMAC verification", async () => {
    const response = await POST(new NextRequest(
      "https://my.yildizskylab.com/internal/v1/native-handoff/redeem",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ code: "b".repeat(43) }),
      },
    ));

    expect(response.status).toBe(400);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("binds HMAC verification to the observed pathname and rejects every query", async () => {
    mocks.verify.mockImplementation((input: { path: string }) => {
      if (input.path !== "/internal/v1/native-handoff/redeem") {
        throw new InvalidNativeBridgeRequestError();
      }
      return {
        requestNonceHash: Buffer.alloc(32, 1),
        requestNonceExpiresAt: new Date("2026-09-20T12:01:00Z"),
      };
    });
    mocks.redeem.mockResolvedValue({
      subject: "user-id",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
    });

    const rewritten = await POST(request(
      undefined,
      "https://my.yildizskylab.com/internal/rewritten/redeem",
    ));
    const query = await POST(request(
      undefined,
      "https://my.yildizskylab.com/internal/v1/native-handoff/redeem?debug=1",
    ));

    expect(rewritten.status).toBe(401);
    expect(query.status).toBe(401);
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({
      path: "/internal/rewritten/redeem",
    }));
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
});
