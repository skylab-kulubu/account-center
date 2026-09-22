// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import meFixture from "../../../tests/fixtures/core-users-me.json";
import {
  ClubProfileService,
  clubProfileServiceFor,
  toClubProfileView,
} from "@/server/club-profile/service";
import { ClubProfilePictureError, ClubProfileValidationError } from "@/server/club-profile/validation";
import {
  CoreProfileUnauthorizedError,
  CoreProfileUnavailableError,
} from "@/server/core/profile-client";
import type { CoreProfile, CoreProfileClient } from "@/server/core/profile-client";

const session = { id: "local-session-id", subject: "authenticated-subject" };
const profile: CoreProfile = { ...meFixture, studentCardLinked: true };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

type FakeCore = { [Key in keyof CoreProfileClient]: ReturnType<typeof vi.fn<CoreProfileClient[Key]>> };

function fakeCore(overrides: Partial<FakeCore> = {}): FakeCore {
  return {
    getMe: vi.fn(async () => profile),
    patchMe: vi.fn(async (_token: string, patch: Record<string, string>) => ({ ...profile, ...patch })),
    uploadProfilePicture: vi.fn(async () => undefined),
    deleteProfilePicture: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeTokens() {
  return { accessToken: vi.fn(async (_session: unknown, options?: { forceRefresh?: boolean }) =>
    options?.forceRefresh ? "refreshed-user-token" : "current-user-token") };
}

describe("club-profile view", () => {
  it("exposes only the fields the page renders and no identifiers", () => {
    expect(toClubProfileView(profile)).toEqual({
      skyNumber: "SKY-0000042",
      studentCardLinked: true,
      schoolEmail: "ada@std.yildiz.edu.tr",
      phone: "+905551112233",
      university: "Yıldız Teknik Üniversitesi",
      faculty: "Elektrik-Elektronik Fakültesi",
      department: "Bilgisayar Mühendisliği",
      linkedin: "https://www.linkedin.com/in/ada-lovelace",
      profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/7c1e0a2b-5d6f-4a8b-9c0d-000000000002.webp",
      updatedAt: "2026-09-21T13:10:41.130Z",
    });
    const serialized = JSON.stringify(toClubProfileView(profile));
    for (const hidden of [profile.id, "account-fixture", "firstName", "profilePictureId", "createdAt"]) {
      expect(serialized).not.toContain(hidden);
    }
  });
});

describe("ClubProfileService", () => {
  it("reads the caller's profile with the session's current user token", async () => {
    const core = fakeCore();
    const tokens = fakeTokens();
    const service = new ClubProfileService(core, tokens);

    await expect(service.read(session)).resolves.toEqual(profile);
    expect(tokens.accessToken).toHaveBeenCalledWith(session);
    expect(core.getMe).toHaveBeenCalledWith("current-user-token");
  });

  it("retries exactly once with a force-refreshed token when core rejects the bearer", async () => {
    const core = fakeCore({
      getMe: vi.fn()
        .mockRejectedValueOnce(new CoreProfileUnauthorizedError())
        .mockResolvedValueOnce(profile),
    });
    const tokens = fakeTokens();
    const service = new ClubProfileService(core, tokens);

    await expect(service.read(session)).resolves.toEqual(profile);
    expect(tokens.accessToken).toHaveBeenNthCalledWith(2, session, { forceRefresh: true });
    expect(core.getMe).toHaveBeenNthCalledWith(2, "refreshed-user-token");

    core.getMe.mockRejectedValue(new CoreProfileUnauthorizedError());
    await expect(service.read(session)).rejects.toBeInstanceOf(CoreProfileUnauthorizedError);
    expect(core.getMe).toHaveBeenCalledTimes(4);
  });

  it("does not retry other core failures", async () => {
    const core = fakeCore({ getMe: vi.fn().mockRejectedValue(new CoreProfileUnavailableError()) });
    const service = new ClubProfileService(core, fakeTokens());
    await expect(service.read(session)).rejects.toBeInstanceOf(CoreProfileUnavailableError);
    expect(core.getMe).toHaveBeenCalledTimes(1);
  });

  it("patches only the changed fields and reports an unchanged form without calling core", async () => {
    const core = fakeCore();
    const service = new ClubProfileService(core, fakeTokens());

    const changed = await service.update(session, {
      university: "Yıldız Teknik Üniversitesi",
      faculty: "  Makine Fakültesi ",
      linkedin: "https://www.linkedin.com/in/ada-lovelace",
    });
    expect(changed).toEqual({ changed: true, profile: { ...profile, faculty: "Makine Fakültesi" } });
    expect(core.patchMe).toHaveBeenCalledWith("current-user-token", { faculty: "Makine Fakültesi" });

    const unchanged = await service.update(session, { department: "Bilgisayar Mühendisliği", linkedin: "https://www.linkedin.com/in/ada-lovelace" });
    expect(unchanged).toEqual({ changed: false, profile });
    expect(core.patchMe).toHaveBeenCalledTimes(1);
  });

  it("clears a field with an empty value and refuses invalid input before reading core", async () => {
    const core = fakeCore();
    const service = new ClubProfileService(core, fakeTokens());

    await service.update(session, { linkedin: "" });
    expect(core.patchMe).toHaveBeenCalledWith("current-user-token", { linkedin: "" });

    await expect(service.update(session, { linkedin: "http://www.linkedin.com/in/ada" }))
      .rejects.toBeInstanceOf(ClubProfileValidationError);
    await expect(service.update(session, { firstName: "Ada" } as Record<string, string>))
      .rejects.toBeInstanceOf(ClubProfileValidationError);
    expect(core.getMe).toHaveBeenCalledTimes(1);
    expect(core.patchMe).toHaveBeenCalledTimes(1);
  });

  it("uploads a sniffed picture and re-reads the profile afterwards", async () => {
    const updated = { ...profile, profilePictureId: "new-id", profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/new-id.png" };
    const core = fakeCore({ getMe: vi.fn(async () => updated) });
    const service = new ClubProfileService(core, fakeTokens());

    await expect(service.uploadPicture(session, png)).resolves.toEqual(updated);
    expect(core.uploadProfilePicture).toHaveBeenCalledWith("current-user-token", { bytes: png, contentType: "image/png" });
    expect(core.getMe).toHaveBeenCalledTimes(1);
    expect(core.uploadProfilePicture.mock.invocationCallOrder[0]).toBeLessThan(core.getMe.mock.invocationCallOrder[0]!);
  });

  it("rejects an unsupported or oversize picture without touching core", async () => {
    const core = fakeCore();
    const service = new ClubProfileService(core, fakeTokens());
    await expect(service.uploadPicture(session, new TextEncoder().encode("GIF89a")))
      .rejects.toBeInstanceOf(ClubProfilePictureError);
    await expect(service.uploadPicture(session, new Uint8Array(0))).rejects.toBeInstanceOf(ClubProfilePictureError);
    expect(core.uploadProfilePicture).not.toHaveBeenCalled();
    expect(core.getMe).not.toHaveBeenCalled();
  });

  it("removes the picture and re-reads the profile", async () => {
    const cleared = { ...profile, profilePictureId: null, profilePictureUrl: null };
    const core = fakeCore({ getMe: vi.fn(async () => cleared) });
    const service = new ClubProfileService(core, fakeTokens());

    await expect(service.removePicture(session)).resolves.toEqual(cleared);
    expect(core.deleteProfilePicture).toHaveBeenCalledWith("current-user-token");
    expect(core.deleteProfilePicture.mock.invocationCallOrder[0]).toBeLessThan(core.getMe.mock.invocationCallOrder[0]!);
  });

  it("is built once per services instance and stays off without a core client", () => {
    const withCore = { account: fakeTokens(), coreProfile: fakeCore() };
    const first = clubProfileServiceFor(withCore);
    expect(first).toBeInstanceOf(ClubProfileService);
    expect(clubProfileServiceFor(withCore)).toBe(first);
    expect(clubProfileServiceFor({ account: fakeTokens(), coreProfile: null })).toBeNull();
  });
});
