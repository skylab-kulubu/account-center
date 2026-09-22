// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeycloakAccountUnauthorizedError, KeycloakAccountUnavailableError } from "@/server/keycloak-account/adapter";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { loadPermissions } from "@/server/permissions/page-data";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorization: vi.fn(),
  groups: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`redirect:${destination}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "opaque-handle" }) }) }));
vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    sessionAccess: { authenticate: mocks.authenticate },
    account: { authorization: mocks.authorization, groups: mocks.groups },
  }),
}));

const session = { id: "session-id", subject: "user-id" };

describe("loadPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ status: "active", value: { session, rotated: false } });
    mocks.authorization.mockResolvedValue({ core: ["url:create"], account: ["manage-account"] });
    mocks.groups.mockResolvedValue([
      { id: "g1", name: "WEBLAB", path: "/UYELER/ARGE/WEBLAB", attributes: { display_name_tr: ["WebLab"] } },
      { id: "g2", name: "LIDERLER", path: "/UYELER/ARGE/WEBLAB/LIDERLER", attributes: {} },
    ]);
  });

  it("builds the view model from the token claim and the groups of the active session", async () => {
    const data = await loadPermissions();
    expect(data).toMatchObject({
      ok: true,
      teamsProblem: null,
      value: {
        membership: "member",
        teams: [expect.objectContaining({ name: "WebLab", role: "leader" })],
        applications: [expect.objectContaining({ clientId: "core" })],
      },
    });
    expect(mocks.authorization).toHaveBeenCalledWith(session);
    expect(mocks.groups).toHaveBeenCalledWith(session);
  });

  it("keeps application permissions when Account REST groups are unavailable", async () => {
    mocks.groups.mockRejectedValue(new KeycloakAccountUnavailableError());
    const data = await loadPermissions();
    expect(data).toMatchObject({
      ok: true,
      teamsProblem: expect.objectContaining({ status: 503 }),
      value: {
        membership: "guest",
        teams: [],
        applications: [expect.objectContaining({ clientId: "core" })],
      },
    });
  });

  it("asks for a fresh login when the token or the groups read needs re-authentication", async () => {
    mocks.authorization.mockRejectedValue(new AccountReauthenticationRequiredError());
    await expect(loadPermissions()).resolves.toMatchObject({ ok: false, problem: { status: 401 } });
    expect(mocks.groups).not.toHaveBeenCalled();

    mocks.authorization.mockResolvedValue({});
    mocks.groups.mockRejectedValue(new KeycloakAccountUnauthorizedError());
    await expect(loadPermissions()).resolves.toMatchObject({ ok: false, problem: { status: 401 } });
  });

  it("redirects sessions that are not active before reading anything", async () => {
    mocks.authenticate.mockResolvedValue({ status: "missing" });
    await expect(loadPermissions()).rejects.toThrow("redirect:/login");
    mocks.authenticate.mockResolvedValue({ status: "blocked" });
    await expect(loadPermissions()).rejects.toThrow("redirect:/api/auth/session/end");
    mocks.authenticate.mockResolvedValue({ status: "unavailable" });
    await expect(loadPermissions()).rejects.toThrow("redirect:/api/auth/unavailable");
    expect(mocks.authorization).not.toHaveBeenCalled();
    expect(mocks.groups).not.toHaveBeenCalled();
  });
});
