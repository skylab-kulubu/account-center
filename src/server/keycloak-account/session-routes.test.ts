// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as DELETE_ALL,
  GET,
} from "@/app/api/account/sessions/route";
import { DELETE as DELETE_ONE } from "@/app/api/account/sessions/[reference]/route";
import { SESSION_COOKIE } from "@/server/auth/http";
import { KeycloakAccountUnavailableError } from "@/server/keycloak-account/adapter";

const routeMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateMutation: vi.fn(),
  csrfToken: vi.fn(),
  managedSessions: vi.fn(),
  revokeOtherSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  revokeLocalSession: vi.fn(),
  config: { appUrl: new URL("https://my.yildizskylab.com") },
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: routeMocks.config,
    sessionAccess: {
      authenticate: routeMocks.authenticate,
      authenticateMutation: routeMocks.authenticateMutation,
    },
    sessions: {
      csrfToken: routeMocks.csrfToken,
      revokeSession: routeMocks.revokeLocalSession,
    },
    account: {
      managedSessions: routeMocks.managedSessions,
      revokeOtherSession: routeMocks.revokeOtherSession,
      revokeOtherSessions: routeMocks.revokeOtherSessions,
    },
  }),
}));

const activeSession = {
  id: "local-session-id",
  subject: "authenticated-subject",
  absoluteExpiresAt: new Date("2026-09-20T20:00:00Z"),
};

function request(
  path = "/api/account/sessions",
  options: { method?: string; origin?: string; csrf?: string } = {},
) {
  const headers = new Headers({ cookie: "__Host-sky-account=opaque-browser-handle" });
  if (options.origin) {
    headers.set("origin", options.origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  return new NextRequest(`https://my.yildizskylab.com${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

describe("account session management routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const active = { status: "active", value: { session: activeSession, rotated: false } };
    routeMocks.authenticate.mockResolvedValue(active);
    routeMocks.authenticateMutation.mockResolvedValue(active);
    routeMocks.csrfToken.mockReturnValue("session-bound-csrf");
    routeMocks.managedSessions.mockResolvedValue([
      {
        reference: null,
        startedAt: "2026-09-20T08:00:00.000Z",
        lastAccessAt: "2026-09-20T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: "Chrome/140.0",
        current: true,
        device: null,
      },
      {
        reference: "r".repeat(43),
        startedAt: "2026-09-19T08:00:00.000Z",
        lastAccessAt: "2026-09-19T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: "Safari/26.0",
        current: false,
        device: null,
      },
    ]);
    routeMocks.revokeOtherSession.mockResolvedValue(undefined);
    routeMocks.revokeOtherSessions.mockResolvedValue(undefined);
    routeMocks.revokeLocalSession.mockResolvedValue(true);
  });

  it("lists only browser-safe sessions and a session-bound mutation proof", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      sessions: expect.arrayContaining([
        expect.objectContaining({ current: true, reference: null }),
        expect.objectContaining({ current: false, reference: "r".repeat(43) }),
      ]),
      csrfToken: "session-bound-csrf",
    });
    expect(routeMocks.managedSessions).toHaveBeenCalledWith(activeSession);
  });

  it("returns a usable no-store unavailable problem without leaking upstream data", async () => {
    routeMocks.managedSessions.mockRejectedValue(new KeycloakAccountUnavailableError());

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      title: "Kimlik hizmetine şu anda ulaşılamıyor",
      instance: "/api/account/sessions",
    });
  });

  it("requires exact-origin CSRF before authenticating a revoke", async () => {
    const response = await DELETE_ALL(request("/api/account/sessions", {
      method: "DELETE",
      origin: "https://attacker.invalid",
      csrf: "session-bound-csrf",
    }));

    expect(response.status).toBe(403);
    expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();
    expect(routeMocks.revokeOtherSessions).not.toHaveBeenCalled();
  });

  it.each([
    "https://my.yildizskylab.com/",
    "https://my.yildizskylab.com/path",
    "https://user@my.yildizskylab.com",
    "https://my.yildizskylab.com:443",
  ])("rejects non-identical raw session mutation origin %s before authentication", async (origin) => {
    const response = await DELETE_ALL(request("/api/account/sessions", {
      method: "DELETE",
      origin,
      csrf: "session-bound-csrf",
    }));

    expect(response.status).toBe(403);
    expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();
    expect(routeMocks.revokeOtherSessions).not.toHaveBeenCalled();
  });

  it("rejects an invalid session-bound mutation proof before Account REST", async () => {
    routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });

    const response = await DELETE_ALL(request("/api/account/sessions", {
      method: "DELETE",
      origin: "https://my.yildizskylab.com",
      csrf: "wrong-proof",
    }));

    expect(response.status).toBe(403);
    expect(routeMocks.revokeOtherSessions).not.toHaveBeenCalled();
  });

  it("revokes all other sessions while preserving and rotating the current opaque session", async () => {
    routeMocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: {
        session: activeSession,
        rotated: true,
        rotatedHandle: "n".repeat(43),
      },
    });

    const response = await DELETE_ALL(request("/api/account/sessions", {
      method: "DELETE",
      origin: "https://my.yildizskylab.com",
      csrf: "session-bound-csrf",
    }));

    expect(response.status).toBe(204);
    expect(routeMocks.revokeOtherSessions).toHaveBeenCalledWith(activeSession);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
  });

  it("delivers a rotated handle even when the upstream revoke is temporarily unavailable", async () => {
    routeMocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: {
        session: activeSession,
        rotated: true,
        rotatedHandle: "u".repeat(43),
      },
    });
    routeMocks.revokeOtherSessions.mockRejectedValue(new KeycloakAccountUnavailableError());

    const response = await DELETE_ALL(request("/api/account/sessions", {
      method: "DELETE",
      origin: "https://my.yildizskylab.com",
      csrf: "session-bound-csrf",
    }));

    expect(response.status).toBe(503);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("u".repeat(43));
    expect(routeMocks.revokeLocalSession).not.toHaveBeenCalled();
  });

  it("revokes one other session by opaque reference without accepting a subject parameter", async () => {
    const response = await DELETE_ONE(
      request(`/api/account/sessions/${"r".repeat(43)}`, {
        method: "DELETE",
        origin: "https://my.yildizskylab.com",
        csrf: "session-bound-csrf",
      }),
      { params: Promise.resolve({ reference: "r".repeat(43) }) },
    );

    expect(response.status).toBe(204);
    expect(routeMocks.revokeOtherSession).toHaveBeenCalledWith(
      activeSession,
      "r".repeat(43),
    );
  });

  it.each(["missing", "blocked", "unavailable"] as const)(
    "does not mutate upstream when local authorization is %s",
    async (status) => {
      routeMocks.authenticateMutation.mockResolvedValue({ status });

      const response = await DELETE_ALL(request("/api/account/sessions", {
        method: "DELETE",
        origin: "https://my.yildizskylab.com",
        csrf: "session-bound-csrf",
      }));

      expect(response.status).toBe(status === "unavailable" ? 503 : 401);
      expect(routeMocks.revokeOtherSessions).not.toHaveBeenCalled();
      if (status === "blocked") expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    },
  );

  it("revokes the local opaque session when Keycloak requires reauthentication", async () => {
    const { AccountReauthenticationRequiredError } = await import(
      "@/server/keycloak-account/service"
    );
    routeMocks.managedSessions.mockRejectedValue(new AccountReauthenticationRequiredError());

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(routeMocks.revokeLocalSession).toHaveBeenCalledWith(activeSession.id);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
  });

  it("clears the browser cookie even when 401 local-session cleanup fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { AccountReauthenticationRequiredError } = await import(
      "@/server/keycloak-account/service"
    );
    routeMocks.managedSessions.mockRejectedValue(new AccountReauthenticationRequiredError());
    routeMocks.revokeLocalSession.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("account_session_cleanup"));
  });
});
