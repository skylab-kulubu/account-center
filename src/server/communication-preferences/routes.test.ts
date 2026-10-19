// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/account/communication-preferences/route";
import type { CommunicationPreferencesView } from "@/lib/communication-preferences";
import { CoreCommunicationPreferencesError } from "@/server/core/communication-preferences-client";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";

const routeMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateMutation: vi.fn(),
  revokeLocalSession: vi.fn(),
  accessToken: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => routeMocks.services,
}));

const activeSession = {
  id: "local-session-id",
  subject: "authenticated-subject",
  absoluteExpiresAt: new Date("2026-10-12T20:00:00Z"),
};

const cell = { explicit: null, enabled: true, origin: "default", from: null, effective: true } as const;
const screen: CommunicationPreferencesView = {
  master: cell,
  club: { duyuru: cell, haber: cell },
  teams: [],
  following: [],
  followable: [],
  tracking: { enabled: true, effective: true },
};

function buildServices(options: { coreEnabled?: boolean } = {}) {
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticate: routeMocks.authenticate, authenticateMutation: routeMocks.authenticateMutation },
    sessions: { revokeSession: routeMocks.revokeLocalSession, csrfToken: () => "session-bound-csrf" },
    account: { accessToken: routeMocks.accessToken },
    coreCommunicationPreferences: options.coreEnabled === false
      ? null
      : { read: routeMocks.read, update: routeMocks.update },
  };
}

function request(
  method: "GET" | "PUT",
  options: { origin?: string | null; csrf?: string; body?: string; contentType?: string } = {},
) {
  const headers = new Headers({ cookie: "__Host-sky-account=opaque-browser-handle" });
  const origin = options.origin === undefined ? "https://my.yildizskylab.com" : options.origin;
  if (method === "PUT") {
    if (origin) {
      headers.set("origin", origin);
      headers.set("sec-fetch-site", "same-origin");
    }
    headers.set("x-csrf-token", options.csrf ?? "session-bound-csrf");
    headers.set("content-type", options.contentType ?? "application/json");
  }
  return new NextRequest("https://my.yildizskylab.com/api/account/communication-preferences", {
    method,
    headers,
    ...(method === "PUT" ? { body: options.body ?? JSON.stringify({ items: [{ category: "club:haber", enabled: false }] }) } : {}),
  });
}

describe("communication preference BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.services = buildServices();
    routeMocks.authenticate.mockResolvedValue({ status: "active", value: { session: activeSession } });
    routeMocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession } });
    routeMocks.revokeLocalSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.read.mockResolvedValue(screen);
    routeMocks.update.mockResolvedValue(screen);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("reads the screen with the session's token, uncached", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ preferences: screen });
    expect(routeMocks.read).toHaveBeenCalledWith("server-held-user-token");
  });

  it("writes the browser's items without Sudo mode and answers core's new screen", async () => {
    const response = await PUT(request("PUT", {
      body: JSON.stringify({ items: [{ category: "team:abc:duyuru", enabled: null }, { category: "all", enabled: false }] }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preferences: screen });
    expect(routeMocks.authenticateMutation).toHaveBeenCalledWith(
      "opaque-browser-handle",
      "session-bound-csrf",
      { allowRotation: true },
    );
    expect(routeMocks.update).toHaveBeenCalledWith("server-held-user-token", {
      items: [
        { category: "team:abc:duyuru", enabled: null },
        { category: "all", enabled: false },
      ],
    });
  });

  it("writes the tracking switch alone or with items", async () => {
    expect((await PUT(request("PUT", { body: JSON.stringify({ tracking: { enabled: false } }) }))).status).toBe(200);
    expect(routeMocks.update).toHaveBeenLastCalledWith("server-held-user-token", { items: [], tracking: false });

    const both = JSON.stringify({ items: [{ category: "all", enabled: true }], tracking: { enabled: true } });
    expect((await PUT(request("PUT", { body: both }))).status).toBe(200);
    expect(routeMocks.update).toHaveBeenLastCalledWith("server-held-user-token", {
      items: [{ category: "all", enabled: true }],
      tracking: true,
    });
  });

  it("retries once with a refreshed token when core refuses the bearer", async () => {
    routeMocks.update
      .mockRejectedValueOnce(new CoreCommunicationPreferencesError("unauthorized"))
      .mockResolvedValueOnce(screen);
    routeMocks.accessToken.mockResolvedValueOnce("stale-token").mockResolvedValueOnce("fresh-token");

    expect((await PUT(request("PUT"))).status).toBe(200);
    expect(routeMocks.accessToken).toHaveBeenLastCalledWith(activeSession, { forceRefresh: true });
    expect(routeMocks.update).toHaveBeenLastCalledWith("fresh-token", { items: expect.any(Array) });
  });

  it("refuses another origin and a wrong CSRF proof before core", async () => {
    expect((await PUT(request("PUT", { origin: "https://attacker.invalid" }))).status).toBe(403);
    routeMocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
    expect((await PUT(request("PUT", { csrf: "wrong" }))).status).toBe(403);
    expect(routeMocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{", "application/json"],
    ["another media type", JSON.stringify({ items: [] }), "text/plain"],
    ["no items", JSON.stringify({ items: [] }), "application/json"],
    ["a channel chosen by the browser", JSON.stringify({ items: [{ category: "all", enabled: false, channel: "sms" }] }), "application/json"],
    ["a missing value", JSON.stringify({ items: [{ category: "all" }] }), "application/json"],
    ["an unknown member", JSON.stringify({ items: [{ category: "all", enabled: true }], source: "admin" }), "application/json"],
    ["a malformed category", JSON.stringify({ items: [{ category: "team:../x:duyuru", enabled: true }] }), "application/json"],
    ["a tracking switch that forgets", JSON.stringify({ tracking: { enabled: null } }), "application/json"],
    ["a tracking switch with another member", JSON.stringify({ tracking: { enabled: false, source: "admin" } }), "application/json"],
    ["a tracking switch that is not an object", JSON.stringify({ tracking: false }), "application/json"],
    ["items that are not a list", JSON.stringify({ items: {}, tracking: { enabled: false } }), "application/json"],
    ["an empty body", JSON.stringify({}), "application/json"],
    ["201 items", JSON.stringify({ items: Array.from({ length: 201 }, (_, index) => ({ category: `team:t${index}:duyuru`, enabled: true })) }), "application/json"],
  ])("refuses %s without calling core", async (_, body, contentType) => {
    const response = await PUT(request("PUT", { body, contentType }));
    expect([400, 415]).toContain(response.status);
    expect(routeMocks.update).not.toHaveBeenCalled();
  });

  it("says the feature is not switched on yet when core has no key", async () => {
    routeMocks.read.mockRejectedValue(new CoreCommunicationPreferencesError("off"));

    const response = await GET(request("GET"));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      title: "İletişim tercihleri şu an kullanılamıyor",
      code: "communication_preferences_unavailable",
    });
  });

  it("passes core's wait on a busy team tree to the browser", async () => {
    routeMocks.update.mockRejectedValue(new CoreCommunicationPreferencesError("teams_unavailable", 30));

    const response = await PUT(request("PUT"));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({ code: "communication_preference_teams_unavailable", retryAfterSeconds: 30 });
  });

  it("names an unknown or hidden team the same way", async () => {
    routeMocks.update.mockRejectedValue(new CoreCommunicationPreferencesError("team_unknown"));

    const response = await PUT(request("PUT"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "communication_preference_team_unknown", title: "Bu ekip bulunamadı" });
  });

  it("is off without core and says so", async () => {
    routeMocks.services = buildServices({ coreEnabled: false });

    const read = await GET(request("GET"));
    const write = await PUT(request("PUT"));

    expect(read.status).toBe(503);
    expect(write.status).toBe(503);
    await expect(read.json()).resolves.toMatchObject({ code: "communication_preferences_disabled" });
  });

  it("keeps the local session on a core 401 but ends it on a Keycloak one", async () => {
    routeMocks.read.mockRejectedValue(new CoreCommunicationPreferencesError("unauthorized"));
    const core = await GET(request("GET"));
    expect(core.status).toBe(401);
    expect(routeMocks.revokeLocalSession).not.toHaveBeenCalled();
    expect(core.headers.get("set-cookie")).toBeNull();

    routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
    const keycloak = await GET(request("GET"));
    expect(keycloak.status).toBe(401);
    expect(routeMocks.revokeLocalSession).toHaveBeenCalledWith(activeSession.id);
    expect(keycloak.headers.get("set-cookie")).toMatch(/__Host-sky-account=;/);
  });

  it("asks for a session first", async () => {
    routeMocks.authenticate.mockResolvedValue({ status: "missing" });
    expect((await GET(request("GET"))).status).toBe(401);
    expect(routeMocks.read).not.toHaveBeenCalled();
  });
});
