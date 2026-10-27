// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "@/app/api/account/team-page-consent/route";
import { CoreConsentError } from "@/server/core/consents-client";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { teamPageStateOf } from "@/server/team-page-consent/service";

const mocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  revokeLocalSession: vi.fn(),
  accessToken: vi.fn(),
  list: vi.fn(),
  grant: vi.fn(),
  withdraw: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => mocks.services,
}));

const activeSession = {
  id: "local-session-id",
  subject: "authenticated-subject",
  absoluteExpiresAt: new Date("2026-10-28T18:00:00Z"),
};

function buildServices(options: { core?: boolean } = {}) {
  const core = options.core !== false;
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticateMutation: mocks.authenticateMutation },
    sessions: { revokeSession: mocks.revokeLocalSession, csrfToken: () => "session-bound-csrf" },
    account: { accessToken: mocks.accessToken },
    coreConsents: core ? { list: mocks.list, grant: mocks.grant, withdraw: mocks.withdraw } : null,
  };
}

function mutation(method: "POST" | "DELETE", options: { origin?: string; csrf?: string; body?: string } = {}) {
  const headers = new Headers({
    cookie: "__Host-sky-account=opaque-browser-handle",
    origin: options.origin ?? "https://my.yildizskylab.com",
    "sec-fetch-site": "same-origin",
    "x-csrf-token": options.csrf ?? "session-bound-csrf",
  });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest("https://my.yildizskylab.com/api/account/team-page-consent", {
    method,
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

describe("team page consent rules", () => {
  it("is active only for an open team_page grant", () => {
    expect(teamPageStateOf([])).toBe("none");
    expect(teamPageStateOf([{ purpose: "promotional", status: "active" }])).toBe("none");
    expect(teamPageStateOf([{ purpose: "team_page", status: "withdrawn" }])).toBe("none");
    expect(teamPageStateOf([
      { purpose: "team_page", status: "withdrawn" },
      { purpose: "team_page", status: "active" },
    ])).toBe("active");
  });
});

describe("team page consent BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession } });
    mocks.revokeLocalSession.mockResolvedValue(true);
    mocks.accessToken.mockResolvedValue("server-held-user-token");
    mocks.list.mockResolvedValue([]);
    mocks.grant.mockResolvedValue(undefined);
    mocks.withdraw.mockResolvedValue(1);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("grants on ekip-sayfasi-v1 from Account Center, without Sudo mode", async () => {
    const response = await POST(mutation("POST"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ teamPage: "active" });
    expect(mocks.authenticateMutation).toHaveBeenCalledWith("opaque-browser-handle", "session-bound-csrf", { allowRotation: true });
    expect(mocks.grant).toHaveBeenCalledWith("server-held-user-token", {
      purpose: "team_page",
      textVersion: "ekip-sayfasi-v1",
      source: "self",
    });
  });

  it("takes nothing from the browser's body", async () => {
    const response = await POST(mutation("POST", { body: JSON.stringify({ purpose: "promotional", textVersion: "tanitim-v1" }) }));

    expect(response.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith("server-held-user-token", expect.objectContaining({ purpose: "team_page", textVersion: "ekip-sayfasi-v1" }));
  });

  it("withdraws the team_page purpose", async () => {
    const response = await DELETE(mutation("DELETE"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ teamPage: "none" });
    expect(mocks.withdraw).toHaveBeenCalledWith("server-held-user-token", "team_page");
  });

  it("refuses another origin and a wrong CSRF proof before core", async () => {
    expect((await POST(mutation("POST", { origin: "https://attacker.invalid" }))).status).toBe(403);
    mocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
    expect((await DELETE(mutation("DELETE", { csrf: "wrong" }))).status).toBe(403);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it("retries once with a refreshed token when core refuses the bearer", async () => {
    mocks.grant.mockRejectedValueOnce(new CoreConsentError("unauthorized")).mockResolvedValueOnce(undefined);
    mocks.accessToken.mockResolvedValueOnce("stale-token").mockResolvedValueOnce("fresh-token");

    expect((await POST(mutation("POST"))).status).toBe(200);
    expect(mocks.accessToken).toHaveBeenLastCalledWith(activeSession, { forceRefresh: true });
    expect(mocks.grant).toHaveBeenLastCalledWith("fresh-token", expect.objectContaining({ purpose: "team_page" }));
  });

  it("says the setting is off without core, its key or the purpose", async () => {
    mocks.grant.mockRejectedValue(new CoreConsentError("off"));
    const off = await POST(mutation("POST"));
    expect(off.status).toBe(503);
    await expect(off.json()).resolves.toMatchObject({ code: "consents_unavailable" });

    mocks.grant.mockRejectedValue(new CoreConsentError("rejected"));
    expect((await POST(mutation("POST"))).status).toBe(400);

    mocks.services = buildServices({ core: false });
    expect((await DELETE(mutation("DELETE"))).status).toBe(503);
  });

  it("keeps the local session on a core 401 but ends it on a Keycloak one", async () => {
    mocks.grant.mockRejectedValue(new CoreConsentError("unauthorized"));
    const core = await POST(mutation("POST"));
    expect(core.status).toBe(401);
    expect(mocks.revokeLocalSession).not.toHaveBeenCalled();

    mocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
    const keycloak = await POST(mutation("POST"));
    expect(keycloak.status).toBe(401);
    expect(mocks.revokeLocalSession).toHaveBeenCalledWith(activeSession.id);
  });
});
