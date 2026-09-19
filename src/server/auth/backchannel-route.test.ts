import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/backchannel-logout/route";
import { BackchannelLogoutReplayError } from "@/server/auth/backchannel-logout";

const routeMocks = vi.hoisted(() => ({ consume: vi.fn() }));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    backchannelLogout: { consume: routeMocks.consume },
  }),
}));

function request(body: string) {
  return new NextRequest("https://my.yildizskylab.com/api/auth/backchannel-logout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("backchannel logout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.consume.mockResolvedValue({ accepted: true, deletedSessions: 1 });
  });

  it("accepts exactly one logout token without echoing it", async () => {
    const response = await POST(request("logout_token=signed.jwt.value"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(routeMocks.consume).toHaveBeenCalledWith("signed.jwt.value");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects duplicate and replayed tokens", async () => {
    const duplicate = await POST(request("logout_token=one&logout_token=two"));
    expect(duplicate.status).toBe(400);
    expect(routeMocks.consume).not.toHaveBeenCalled();

    routeMocks.consume.mockRejectedValue(new BackchannelLogoutReplayError());
    const replay = await POST(request("logout_token=signed.jwt.value"));
    expect(replay.status).toBe(400);
  });

  it("caps a chunked or missing-length request body by streamed bytes", async () => {
    const oversized = request(`logout_token=${"x".repeat(16_385)}`);
    expect(oversized.headers.get("content-length")).toBeNull();
    const response = await POST(oversized);

    expect(response.status).toBe(413);
    expect(routeMocks.consume).not.toHaveBeenCalled();
  });
});
