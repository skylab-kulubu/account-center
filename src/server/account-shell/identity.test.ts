// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import meFixture from "../../../tests/fixtures/core-users-me.json";
import { loadProfilePictureUrl, loadShellIdentity } from "@/server/account-shell/identity";
import { CoreProfileUnavailableError } from "@/server/core/profile-client";
import type { CoreProfile } from "@/server/core/profile-client";
import { KeycloakAccountUnavailableError } from "@/server/keycloak-account/adapter";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  accessToken: vi.fn(),
  profile: vi.fn(),
  getMe: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "opaque-handle" }) }) }));
vi.mock("@/server/auth/services", () => ({ getAuthServices: () => mocks.services }));

const session = { id: "session-id", subject: "user-id" };
const core: CoreProfile = {
  ...meFixture,
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.invalid",
  profilePictureUrl: "https://cdn.yildizskylab.com/p/ada.webp",
} as CoreProfile;

function buildServices(coreEnabled = true) {
  return {
    sessionAccess: { authenticate: mocks.authenticate },
    account: { accessToken: mocks.accessToken, profile: mocks.profile },
    coreProfile: coreEnabled
      ? { getMe: mocks.getMe, patchMe: vi.fn(), uploadProfilePicture: vi.fn(), deleteProfilePicture: vi.fn(), deleteStudentCard: vi.fn() }
      : null,
  };
}

describe("loadShellIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticate.mockResolvedValue({ status: "active", value: { session, rotated: false } });
    mocks.accessToken.mockResolvedValue("server-held-user-token");
    mocks.getMe.mockResolvedValue(core);
    mocks.profile.mockResolvedValue({
      username: "ada",
      firstName: "Ada",
      lastName: "Keycloak",
      email: "primary@example.invalid",
      emailVerified: true,
      attributes: {},
      attributeMetadata: [],
    });
  });

  it("reads the name, e-mail and photo from core's profile", async () => {
    await expect(loadShellIdentity()).resolves.toEqual({
      name: "Ada Lovelace",
      email: "ada@example.invalid",
      pictureUrl: "https://cdn.yildizskylab.com/p/ada.webp",
    });
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("falls back to Keycloak without core, or when core fails", async () => {
    mocks.services = buildServices(false);
    await expect(loadShellIdentity()).resolves.toEqual({ name: "Ada Keycloak", email: "primary@example.invalid", pictureUrl: null });

    mocks.services = buildServices();
    mocks.getMe.mockRejectedValue(new CoreProfileUnavailableError());
    await expect(loadShellIdentity()).resolves.toEqual({ name: "Ada Keycloak", email: "primary@example.invalid", pictureUrl: null });
  });

  it("answers null when neither answers, and for a session that is not active", async () => {
    mocks.getMe.mockRejectedValue(new CoreProfileUnavailableError());
    mocks.profile.mockRejectedValue(new KeycloakAccountUnavailableError());
    await expect(loadShellIdentity()).resolves.toBeNull();

    mocks.authenticate.mockResolvedValue({ status: "missing" });
    await expect(loadShellIdentity()).resolves.toBeNull();
  });

  it("uses the username when the profile has no name", async () => {
    mocks.getMe.mockResolvedValue({ ...core, firstName: null, lastName: null, username: "ada" });
    await expect(loadShellIdentity()).resolves.toMatchObject({ name: "ada" });
  });
});

describe("loadProfilePictureUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticate.mockResolvedValue({ status: "active", value: { session, rotated: false } });
    mocks.accessToken.mockResolvedValue("server-held-user-token");
    mocks.getMe.mockResolvedValue(core);
  });

  it("answers core's photo, the one the account menu shows, without asking Keycloak", async () => {
    await expect(loadProfilePictureUrl()).resolves.toBe("https://cdn.yildizskylab.com/p/ada.webp");
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("answers null without core, without a photo, when core fails, or for a session that is not active", async () => {
    mocks.getMe.mockResolvedValue({ ...core, profilePictureUrl: null });
    await expect(loadProfilePictureUrl()).resolves.toBeNull();

    mocks.getMe.mockRejectedValue(new CoreProfileUnavailableError());
    await expect(loadProfilePictureUrl()).resolves.toBeNull();

    mocks.services = buildServices(false);
    await expect(loadProfilePictureUrl()).resolves.toBeNull();

    mocks.authenticate.mockResolvedValue({ status: "missing" });
    await expect(loadProfilePictureUrl()).resolves.toBeNull();
    expect(mocks.profile).not.toHaveBeenCalled();
  });
});
