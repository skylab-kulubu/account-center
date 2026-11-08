// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/account/app-preferences/[app]/route";
import { AppPreferencesService } from "@/server/app-preferences/service";
import { CoreAppPreferencesError } from "@/server/core/app-preferences-client";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";

const mocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  revokeLocalSession: vi.fn(),
  accessToken: vi.fn(),
  summary: vi.fn(),
  reset: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => mocks.services,
}));

const activeSession = {
  id: "local-session-id",
  subject: "authenticated-subject",
  absoluteExpiresAt: new Date("2026-11-08T18:00:00Z"),
};

function buildServices(options: { core?: boolean } = {}) {
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticateMutation: mocks.authenticateMutation },
    sessions: { revokeSession: mocks.revokeLocalSession, csrfToken: () => "session-bound-csrf" },
    account: { accessToken: mocks.accessToken },
    coreAppPreferences: options.core === false ? null : { summary: mocks.summary, reset: mocks.reset },
  };
}

function reset(app: string, options: { origin?: string; csrf?: string } = {}) {
  const request = new NextRequest(`https://my.yildizskylab.com/api/account/app-preferences/${app}`, {
    method: "DELETE",
    headers: {
      cookie: "__Host-sky-account=opaque-browser-handle",
      origin: options.origin ?? "https://my.yildizskylab.com",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": options.csrf ?? "session-bound-csrf",
    },
  });
  return DELETE(request, { params: Promise.resolve({ app }) });
}

describe("app preferences reset BFF route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession } });
    mocks.revokeLocalSession.mockResolvedValue(true);
    mocks.accessToken.mockResolvedValue("server-held-user-token");
    mocks.reset.mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("resets the app with the session's token, without Sudo mode", async () => {
    const response = await reset("forms");

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.authenticateMutation).toHaveBeenCalledWith("opaque-browser-handle", "session-bound-csrf", { allowRotation: true });
    expect(mocks.reset).toHaveBeenCalledWith("server-held-user-token", "forms");
  });

  it("refuses an app name outside core's rule before core", async () => {
    expect((await reset("Forms")).status).toBe(400);
    expect((await reset("forms%2Fkey")).status).toBe(400);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("refuses another origin and a wrong CSRF proof before core", async () => {
    expect((await reset("forms", { origin: "https://attacker.invalid" })).status).toBe(403);
    mocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
    expect((await reset("forms", { csrf: "wrong" })).status).toBe(403);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("treats core's 404 (feature off or unknown app) as nothing left to reset", async () => {
    mocks.reset.mockRejectedValue(new CoreAppPreferencesError("off"));
    expect((await reset("forms")).status).toBe(204);
  });

  it("says the feature is off without core", async () => {
    mocks.services = buildServices({ core: false });
    expect((await reset("forms")).status).toBe(503);
  });

  it("retries once with a refreshed token when core refuses the bearer", async () => {
    mocks.reset.mockRejectedValueOnce(new CoreAppPreferencesError("unauthorized")).mockResolvedValueOnce(undefined);
    mocks.accessToken.mockResolvedValueOnce("stale-token").mockResolvedValueOnce("fresh-token");

    expect((await reset("forms")).status).toBe(204);
    expect(mocks.accessToken).toHaveBeenLastCalledWith(activeSession, { forceRefresh: true });
    expect(mocks.reset).toHaveBeenLastCalledWith("fresh-token", "forms");
  });

  it("passes core's rate limit on", async () => {
    mocks.reset.mockRejectedValue(new CoreAppPreferencesError("rate_limited"));
    expect((await reset("forms")).status).toBe(429);
  });

  it("keeps the local session on a core 401 but ends it on a Keycloak one", async () => {
    mocks.reset.mockRejectedValue(new CoreAppPreferencesError("unauthorized"));
    expect((await reset("forms")).status).toBe(401);
    expect(mocks.revokeLocalSession).not.toHaveBeenCalled();

    mocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
    expect((await reset("forms")).status).toBe(401);
    expect(mocks.revokeLocalSession).toHaveBeenCalledWith(activeSession.id);
  });
});

describe("app preferences summary", () => {
  it("reads core's 404 as an empty list and surfaces other failures", async () => {
    const tokens = { accessToken: vi.fn().mockResolvedValue("token") };
    const core = { summary: vi.fn(), reset: vi.fn() };
    const service = new AppPreferencesService(core, tokens);
    const session = { id: "s", subject: "u" };

    core.summary.mockRejectedValueOnce(new CoreAppPreferencesError("off"));
    await expect(service.summary(session)).resolves.toEqual([]);

    core.summary.mockRejectedValueOnce(new CoreAppPreferencesError("unavailable"));
    await expect(service.summary(session)).rejects.toBeInstanceOf(CoreAppPreferencesError);
  });
});
