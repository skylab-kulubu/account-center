// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "@/app/api/account/promotional-consent/route";
import { CoreConsentError } from "@/server/core/consents-client";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { promotionalStateOf } from "@/server/promotional-consent/service";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
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
  absoluteExpiresAt: new Date("2026-10-24T18:00:00Z"),
};

function buildServices(options: { core?: boolean } = {}) {
  const core = options.core !== false;
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticate: mocks.authenticate, authenticateMutation: mocks.authenticateMutation },
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
  if (method === "POST") headers.set("content-type", "application/json");
  return new NextRequest("https://my.yildizskylab.com/api/account/promotional-consent", {
    method,
    headers,
    ...(method === "POST" ? { body: options.body ?? JSON.stringify({ source: "self" }) } : {}),
  });
}

describe("promotional consent rules", () => {
  it("reads active before pending, and only the promotional purpose", () => {
    expect(promotionalStateOf([])).toBe("none");
    expect(promotionalStateOf([{ purpose: "event_invitations", status: "active" }])).toBe("none");
    expect(promotionalStateOf([{ purpose: "promotional", status: "withdrawn" }])).toBe("none");
    expect(promotionalStateOf([{ purpose: "promotional", status: "pending" }])).toBe("pending");
    expect(promotionalStateOf([
      { purpose: "promotional", status: "pending" },
      { purpose: "promotional", status: "active" },
    ])).toBe("active");
  });
});

describe("promotional consent BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticate.mockResolvedValue({ status: "active", value: { session: activeSession } });
    mocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession } });
    mocks.revokeLocalSession.mockResolvedValue(true);
    mocks.accessToken.mockResolvedValue("server-held-user-token");
    mocks.list.mockResolvedValue([]);
    mocks.grant.mockResolvedValue(undefined);
    mocks.withdraw.mockResolvedValue(1);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("grants on tanitim-v1 with source self, without Sudo mode", async () => {
    const response = await POST(mutation("POST"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ promotional: "active" });
    expect(mocks.authenticateMutation).toHaveBeenCalledWith("opaque-browser-handle", "session-bound-csrf", { allowRotation: true });
    expect(mocks.grant).toHaveBeenCalledWith("server-held-user-token", {
      purpose: "promotional",
      textVersion: "tanitim-v1",
      source: "self",
    });
  });

  it("withdraws the promotional purpose", async () => {
    const response = await DELETE(mutation("DELETE"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ promotional: "none" });
    expect(mocks.withdraw).toHaveBeenCalledWith("server-held-user-token", "promotional");
  });

  it.each([
    ["another source", JSON.stringify({ source: "forms" })],
    ["the dropped signup source", JSON.stringify({ source: "signup" })],
    ["a purpose chosen by the browser", JSON.stringify({ source: "self", purpose: "event_invitations" })],
    ["a text version chosen by the browser", JSON.stringify({ source: "self", textVersion: "davet-v2" })],
    ["no source", JSON.stringify({})],
    ["not JSON", "{"],
  ])("refuses %s without calling core", async (_, body) => {
    const response = await POST(mutation("POST", { body }));
    expect(response.status).toBe(400);
    expect(mocks.grant).not.toHaveBeenCalled();
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
    expect(mocks.grant).toHaveBeenLastCalledWith("fresh-token", expect.objectContaining({ source: "self" }));
  });

  it("asks for another try while core cannot read the person's addresses", async () => {
    mocks.withdraw.mockRejectedValue(new CoreConsentError("addresses_unavailable", 5));

    const response = await DELETE(mutation("DELETE"));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({ code: "consent_addresses_unavailable" });
  });

  it("says the consent is off without core or its key", async () => {
    mocks.grant.mockRejectedValue(new CoreConsentError("off"));
    const off = await POST(mutation("POST"));
    expect(off.status).toBe(503);
    await expect(off.json()).resolves.toMatchObject({ code: "consents_unavailable" });

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
