import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/logout/route";
import { SESSION_COOKIE } from "@/server/auth/http";
import { DeletedSessionTokenDecryptError } from "@/server/auth/sessions";

const logoutMocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  deleteSessionAndGetTokens: vi.fn(),
  revokeRefreshToken: vi.fn(),
  logAuthEvent: vi.fn(),
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: logoutMocks.logAuthEvent,
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessions: {
      authenticateCleanupMutation: logoutMocks.authenticateMutation,
      deleteSessionAndGetTokens: logoutMocks.deleteSessionAndGetTokens,
    },
    oidc: { revokeRefreshToken: logoutMocks.revokeRefreshToken },
  }),
}));

function request(options: { body?: string; contentType?: string } = {}) {
  return new NextRequest("https://my.yildizskylab.com/api/auth/logout", {
    method: "POST",
    headers: {
      origin: "https://my.yildizskylab.com",
      "sec-fetch-site": "same-origin",
      "content-type": options.contentType ?? "application/x-www-form-urlencoded",
      cookie: `${SESSION_COOKIE}=${"h".repeat(43)}`,
    },
    body: options.body ?? "csrfToken=session-bound-proof",
  });
}

describe("local logout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logoutMocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: { id: "session-id" } },
    });
    logoutMocks.deleteSessionAndGetTokens.mockResolvedValue({
      accessToken: "access",
      idToken: "id",
      refreshToken: "refresh",
      tokenType: "bearer",
    });
    logoutMocks.revokeRefreshToken.mockResolvedValue(undefined);
  });

  it("hard-deletes local token material before revoking the upstream refresh token", async () => {
    const response = await POST(request());

    expect(logoutMocks.authenticateMutation).toHaveBeenCalledWith(
      "h".repeat(43),
      "session-bound-proof",
    );
    expect(logoutMocks.deleteSessionAndGetTokens).toHaveBeenCalledWith("session-id");
    expect(logoutMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh");
    expect(
      logoutMocks.deleteSessionAndGetTokens.mock.invocationCallOrder[0],
    ).toBeLessThan(logoutMocks.revokeRefreshToken.mock.invocationCallOrder[0]!);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?loggedOut=1",
    );
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
  });

  it("still clears the local cookie when upstream revocation is unavailable", async () => {
    logoutMocks.revokeRefreshToken.mockRejectedValue(new Error("provider unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(303);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
  });

  it("completes local logout when deleted token material cannot be decrypted", async () => {
    logoutMocks.deleteSessionAndGetTokens.mockRejectedValue(
      new DeletedSessionTokenDecryptError(),
    );

    const response = await POST(request());

    expect(response.status).toBe(303);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(logoutMocks.revokeRefreshToken).not.toHaveBeenCalled();
    expect(logoutMocks.logAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "deleted_token_decrypt_failed" }),
    );
  });

  it("requires the exact form media type and caps streamed bytes without Content-Length", async () => {
    const parameterized = await POST(request({
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    }));
    const oversizedRequest = request({ body: `csrfToken=${"x".repeat(1_025)}` });
    expect(oversizedRequest.headers.get("content-length")).toBeNull();
    const oversized = await POST(oversizedRequest);

    expect(parameterized.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(logoutMocks.authenticateMutation).not.toHaveBeenCalled();
  });
});
