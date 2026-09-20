// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/account/route";
import { KeycloakAccountContractError } from "@/server/keycloak-account/schema";
import { SESSION_COOKIE } from "@/server/auth/http";

const routeMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    sessionAccess: { authenticate: routeMocks.authenticate },
    account: { snapshot: routeMocks.snapshot },
  }),
}));

function request(withCookie = true) {
  return new NextRequest("https://my.yildizskylab.com/api/account", {
    headers: withCookie ? { cookie: "__Host-sky-account=opaque-browser-handle" } : {},
  });
}

describe("Account snapshot route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.authenticate.mockResolvedValue({
      status: "active",
      value: {
        session: { id: "session-id", subject: "user-id" },
        rotated: false,
      },
    });
    routeMocks.snapshot.mockResolvedValue({
      profile: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.invalid",
        emailVerified: true,
      },
      authentication: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
      sessions: [],
    });
  });

  it("returns only the normalized no-store view model", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({
      profile: expect.objectContaining({ firstName: "Ada" }),
      sessions: [],
    }));
    expect(routeMocks.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-id", subject: "user-id" }),
    );
  });

  it("does not call Account REST without a browser session", async () => {
    routeMocks.authenticate.mockResolvedValue({ status: "missing" });
    const response = await GET(request(false));
    expect(response.status).toBe(401);
    expect(routeMocks.snapshot).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      status: 401,
      instance: "/api/account",
    });
  });

  it("maps drift to a safe problem without upstream bodies or tokens", async () => {
    const error = new KeycloakAccountContractError("sessions") as Error & { raw?: unknown };
    error.raw = { token: "server-token", ipAddress: "203.0.113.42" };
    routeMocks.snapshot.mockRejectedValue(error);
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = await response.text();
    expect(body).toContain("Kimlik bilgileri güvenle durduruldu");
    expect(body).not.toContain("server-token");
    expect(body).not.toContain("203.0.113.42");
    expect(body).not.toContain("sessions");
  });

  it("clears blocked sessions generically and performs no account read", async () => {
    routeMocks.authenticate.mockResolvedValue({ status: "blocked" });

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "authentication_required" });
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(routeMocks.snapshot).not.toHaveBeenCalled();
  });

  it("returns retryable 503 and performs no account read when the gate is unavailable", async () => {
    routeMocks.authenticate.mockResolvedValue({ status: "unavailable" });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("3");
    expect(routeMocks.snapshot).not.toHaveBeenCalled();
  });
});
