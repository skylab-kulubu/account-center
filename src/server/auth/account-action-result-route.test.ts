// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/action-result/[reference]/route";
import { SESSION_COOKIE } from "@/server/auth/http";

const mocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticateMutation: mocks.authenticateMutation },
    actionResults: { consume: mocks.acknowledge },
  }),
}));

const activeSession = {
  id: "d9a9bb4a-4977-4f07-8eb7-d3ba5c45e5cd",
  subject: "user-id",
  absoluteExpiresAt: new Date("2026-09-20T18:00:00Z"),
};

function request(options: { origin?: string; csrf?: string } = {}) {
  const headers = new Headers({
    cookie: `${SESSION_COOKIE}=${"h".repeat(43)}`,
  });
  if (options.origin) {
    headers.set("origin", options.origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  return new NextRequest(
    `https://my.yildizskylab.com/api/auth/action-result/${"r".repeat(43)}`,
    { method: "POST", headers },
  );
}

function acknowledge(
  options: { origin?: string; csrf?: string; reference?: string } = {},
) {
  return POST(
    request({
      origin: options.origin ?? "https://my.yildizskylab.com",
      csrf: options.csrf ?? "session-proof",
    }),
    { params: Promise.resolve({ reference: options.reference ?? "r".repeat(43) }) },
  );
}

describe("account action result acknowledgement route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotated: false },
    });
    mocks.acknowledge.mockResolvedValue({ action: "otp", outcome: "success" });
  });

  it.each([
    "https://attacker.invalid",
    "https://my.yildizskylab.com/",
    "https://my.yildizskylab.com/path",
    "https://user@my.yildizskylab.com",
    "https://my.yildizskylab.com:443",
  ])("rejects non-identical raw origin %s before authentication", async (origin) => {
    const response = await acknowledge({ origin });

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.authenticateMutation).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("requires the session-bound CSRF proof without rotating the session", async () => {
    mocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
    const response = await acknowledge({ csrf: "wrong-proof" });

    expect(response.status).toBe(403);
    expect(mocks.authenticateMutation).toHaveBeenCalledWith(
      "h".repeat(43),
      "wrong-proof",
      { allowRotation: false },
    );
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("atomically acknowledges only the current session result", async () => {
    const response = await acknowledge();

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.acknowledge).toHaveBeenCalledWith("r".repeat(43), activeSession.id);
  });

  it.each([null, undefined])(
    "does not reveal whether an invalid, foreign, expired or replayed result existed (%s)",
    async (outcome) => {
      mocks.acknowledge.mockResolvedValue(outcome);
      const response = await acknowledge({ reference: "forged" });

      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");
    },
  );

  it.each(["missing", "blocked", "unavailable"] as const)(
    "fails closed without acknowledging when authorization is %s",
    async (status) => {
      mocks.authenticateMutation.mockResolvedValue({ status });
      const response = await acknowledge();

      expect(response.status).toBe(status === "unavailable" ? 503 : 401);
      expect(mocks.acknowledge).not.toHaveBeenCalled();
      if (status === "blocked") expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    },
  );

  it("keeps the result retryable when storage is unavailable", async () => {
    mocks.acknowledge.mockRejectedValue(new Error("database unavailable"));
    const response = await acknowledge();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
  });
});
