// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import meFixture from "../../../tests/fixtures/core-users-me.json";
import { loadClubProfilePage } from "@/server/club-profile/page-data";
import { CoreProfileUnavailableError } from "@/server/core/profile-client";
import type { CoreProfile } from "@/server/core/profile-client";
import { KeycloakAccountUnavailableError } from "@/server/keycloak-account/adapter";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  accessToken: vi.fn(),
  profile: vi.fn(),
  csrfToken: vi.fn(),
  getMe: vi.fn(),
  services: {} as Record<string, unknown>,
  redirect: vi.fn((destination: string) => {
    throw new Error(`redirect:${destination}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "opaque-handle" }) }) }));
vi.mock("@/server/auth/services", () => ({ getAuthServices: () => mocks.services }));

const session = { id: "session-id", subject: "user-id" };
const profile: CoreProfile = { ...meFixture, studentCardLinked: true };

function buildServices(options: { coreEnabled?: boolean } = {}) {
  return {
    sessionAccess: { authenticate: mocks.authenticate },
    sessions: { csrfToken: mocks.csrfToken },
    account: { accessToken: mocks.accessToken, profile: mocks.profile },
    coreProfile: options.coreEnabled === false ? null : {
      getMe: mocks.getMe,
      patchMe: vi.fn(),
      uploadProfilePicture: vi.fn(),
      deleteProfilePicture: vi.fn(),
    },
  };
}

describe("loadClubProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticate.mockResolvedValue({ status: "active", value: { session, rotated: false } });
    mocks.accessToken.mockResolvedValue("server-held-user-token");
    mocks.csrfToken.mockReturnValue("session-bound-csrf");
    mocks.getMe.mockResolvedValue(profile);
    mocks.profile.mockResolvedValue({
      username: "ada",
      firstName: "Ada",
      lastName: "Keycloak",
      email: "primary@example.invalid",
      emailVerified: true,
      attributes: { schoolEmail: "ada@std.yildiz.edu.tr", personalEmail: null, skyNumber: "SKY-KC", department: null, university: null },
      attributeMetadata: [],
    });
  });

  it("serves the identity summary and the club fields from a single core read", async () => {
    const data = await loadClubProfilePage();

    expect(data).toEqual({
      identity: {
        ok: true,
        value: {
          displayName: "Ada Lovelace",
          email: "ada@std.yildiz.edu.tr",
          schoolEmail: "ada@std.yildiz.edu.tr",
          skyNumber: "SKY-0000042",
        },
      },
      clubProfile: {
        status: "ready",
        value: expect.objectContaining({ faculty: "Elektrik-Elektronik Fakültesi", studentCardLinked: true, phone: "+905551112233" }),
      },
      csrfToken: "session-bound-csrf",
    });
    expect(JSON.stringify(data)).not.toContain(meFixture.id);
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("falls back to the Keycloak identity with a problem banner when core fails", async () => {
    mocks.getMe.mockRejectedValue(new CoreProfileUnavailableError());

    const data = await loadClubProfilePage();

    expect(data.clubProfile).toMatchObject({ status: "problem", problem: { status: 503, title: "Kulüp profiline şu anda ulaşılamıyor" } });
    expect(data.identity).toEqual({
      ok: true,
      value: {
        displayName: "Ada Keycloak",
        email: "primary@example.invalid",
        schoolEmail: "ada@std.yildiz.edu.tr",
        skyNumber: "SKY-KC",
      },
    });
    expect(mocks.profile).toHaveBeenCalledWith(session);
  });

  it("reports the disabled state and still reads the Keycloak identity without core", async () => {
    mocks.services = buildServices({ coreEnabled: false });

    const data = await loadClubProfilePage();

    expect(data.clubProfile).toEqual({ status: "disabled" });
    expect(data.identity).toMatchObject({ ok: true, value: { displayName: "Ada Keycloak" } });
    expect(mocks.getMe).not.toHaveBeenCalled();
  });

  it("carries both problems when core and Keycloak fail", async () => {
    mocks.getMe.mockRejectedValue(new CoreProfileUnavailableError());
    mocks.profile.mockRejectedValue(new KeycloakAccountUnavailableError());

    const data = await loadClubProfilePage();

    expect(data.clubProfile).toMatchObject({ status: "problem", problem: { status: 503 } });
    expect(data.identity).toMatchObject({ ok: false, problem: { status: 503, title: "Kimlik hizmetine şu anda ulaşılamıyor" } });
  });

  it("asks for a fresh login when the session token cannot be refreshed", async () => {
    mocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
    mocks.profile.mockRejectedValue(new AccountReauthenticationRequiredError());

    const data = await loadClubProfilePage();

    expect(data.clubProfile).toMatchObject({ status: "problem", problem: { status: 401 } });
    expect(data.identity).toMatchObject({ ok: false, problem: { status: 401 } });
  });

  it("redirects sessions that are not active before reading anything", async () => {
    mocks.authenticate.mockResolvedValue({ status: "missing" });
    await expect(loadClubProfilePage()).rejects.toThrow("redirect:/login");
    mocks.authenticate.mockResolvedValue({ status: "blocked" });
    await expect(loadClubProfilePage()).rejects.toThrow("redirect:/api/auth/session/end");
    mocks.authenticate.mockResolvedValue({ status: "unavailable" });
    await expect(loadClubProfilePage()).rejects.toThrow("redirect:/api/auth/unavailable");
    expect(mocks.getMe).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
  });
});
