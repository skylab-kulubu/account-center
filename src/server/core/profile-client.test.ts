// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import meFixture from "../../../tests/fixtures/core-users-me.json";
import {
  CORE_PROFILE_PICTURE_FIELD,
  CoreProfileContractError,
  CoreProfileForbiddenError,
  CoreProfileHttpClient,
  CoreProfileInvalidInputError,
  CoreProfileNotFoundError,
  CoreProfileRejectedError,
  CoreProfileUnauthorizedError,
  CoreProfileUnavailableError,
} from "@/server/core/profile-client";

const baseUrl = new URL("https://api.yildizskylab.com");
const accessToken = "server-held-user-token";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("Core profile HTTP client", () => {
  it("requires a canonical credential-free HTTPS core origin", () => {
    for (const invalid of [
      "http://api.yildizskylab.com",
      "https://user:secret@api.yildizskylab.com",
      "https://api.yildizskylab.com/v1",
      "https://api.yildizskylab.com/?debug=1",
    ]) {
      expect(() => new CoreProfileHttpClient(new URL(invalid))).toThrow(/Core API URL/);
    }
    expect(() => new CoreProfileHttpClient(baseUrl)).not.toThrow();
  });

  it("reads the caller's own profile with the session bearer only", async () => {
    const fetch = vi.fn().mockResolvedValue(json(meFixture));
    vi.stubGlobal("fetch", fetch);

    const profile = await new CoreProfileHttpClient(baseUrl).getMe(accessToken);

    expect(profile).toEqual({
      id: "0f6d2c1e-3b4a-4d5e-8f90-000000000001",
      email: "ada@std.yildiz.edu.tr",
      firstName: "Ada",
      lastName: "Lovelace",
      username: "account-fixture",
      schoolEmail: "ada@std.yildiz.edu.tr",
      skyNumber: "SKY-0000042",
      studentCardLinked: true,
      linkedin: "https://www.linkedin.com/in/ada-lovelace",
      university: "Yıldız Teknik Üniversitesi",
      faculty: "Elektrik-Elektronik Fakültesi",
      department: "Bilgisayar Mühendisliği",
      profilePictureId: "7c1e0a2b-5d6f-4a8b-9c0d-000000000002",
      profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/7c1e0a2b-5d6f-4a8b-9c0d-000000000002.webp",
      phone: "+905551112233",
      ytuLinked: false,
      createdAt: "2025-10-01T09:00:00Z",
      updatedAt: "2026-09-21T13:10:41.130Z",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/users/me"),
      expect.objectContaining({
        method: "GET",
        body: null,
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", authorization: "Bearer server-held-user-token" },
      }),
    );
  });

  it("ignores additive members of later core releases", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      ...meFixture,
      status: "active",
      memberships: [{ team: "weblab" }],
    })));
    const profile = await new CoreProfileHttpClient(baseUrl).getMe(accessToken);
    expect(profile).toMatchObject({ id: meFixture.id, skyNumber: "SKY-0000042" });
    expect(Object.keys(profile).sort()).toEqual([
      "createdAt", "department", "email", "faculty", "firstName", "id", "lastName", "linkedin", "phone",
      "profilePictureId", "profilePictureUrl", "schoolEmail", "skyNumber", "studentCardLinked",
      "university", "updatedAt", "username", "ytuLinked",
    ]);
    expect(JSON.stringify(profile)).not.toContain("memberships");
  });

  it("treats omitted optional fields as absent values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      id: meFixture.id,
      email: meFixture.email,
      createdAt: meFixture.createdAt,
      updatedAt: meFixture.updatedAt,
    })));
    const profile = await new CoreProfileHttpClient(baseUrl).getMe(accessToken);
    expect(profile).toMatchObject({
      id: meFixture.id,
      firstName: null,
      skyNumber: null,
      studentCardLinked: false,
      ytuLinked: false,
      linkedin: null,
      profilePictureId: null,
      profilePictureUrl: null,
      phone: null,
    });
  });

  it("reads whether university, faculty and department follow the YTÜ login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...meFixture, ytuLinked: true })));
    await expect(new CoreProfileHttpClient(baseUrl).getMe(accessToken)).resolves.toMatchObject({ ytuLinked: true });
    // A core older than C2 does not send the member: nobody is YTÜ-linked then.
    const olderCore = Object.fromEntries(Object.entries(meFixture).filter(([key]) => key !== "ytuLinked"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(olderCore)));
    await expect(new CoreProfileHttpClient(baseUrl).getMe(accessToken)).resolves.toMatchObject({ ytuLinked: false });
  });

  it("patches only the allowed club-profile and shadow-name fields as JSON", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...meFixture, faculty: "Makine Fakültesi", updatedAt: "2026-09-21T14:00:00Z" }));
    vi.stubGlobal("fetch", fetch);
    const client = new CoreProfileHttpClient(baseUrl);

    const profile = await client.patchMe(accessToken, { faculty: " Makine Fakültesi ", linkedin: "" });

    expect(profile.faculty).toBe("Makine Fakültesi");
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/users/me"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ faculty: "Makine Fakültesi", linkedin: "" }),
        headers: {
          accept: "application/json",
          authorization: "Bearer server-held-user-token",
          "content-type": "application/json",
        },
      }),
    );

    for (const patch of [
      {},
      { phone: "+905550000000" },
      { skyNumber: "SKY-1" },
      { firstName: "A".repeat(256) },
      { linkedin: "https://linkedin.com/in/" + "x".repeat(512) },
      { department: "Bilgisayar\u0000" },
      { university: 42 },
    ]) {
      await expect(client.patchMe(accessToken, patch as Record<string, string>))
        .rejects.toBeInstanceOf(CoreProfileInvalidInputError);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uploads the picture as multipart under the pinned field and never retries", async () => {
    let attempts = 0;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      const form = init?.body;
      expect(form).toBeInstanceOf(FormData);
      const file = (form as FormData).get(CORE_PROFILE_PICTURE_FIELD);
      expect(file).toBeInstanceOf(File);
      expect((file as File).type).toBe("image/png");
      expect((file as File).name).toBe("profile.png");
      expect(await (file as File).arrayBuffer()).toEqual(new Uint8Array([137, 80, 78, 71]).buffer);
      expect([...(form as FormData).keys()]).toEqual([CORE_PROFILE_PICTURE_FIELD]);
      const headers = init?.headers as Record<string, string>;
      expect(headers["content-type"]).toBeUndefined();
      expect(headers.authorization).toBe("Bearer server-held-user-token");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const client = new CoreProfileHttpClient(baseUrl);

    await expect(client.uploadProfilePicture(accessToken, {
      bytes: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    })).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL("https://api.yildizskylab.com/v1/users/me/profile-picture"));
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(attempts).toBe(1);

    for (const invalid of [
      { bytes: new Uint8Array(0), contentType: "image/png" },
      { bytes: new Uint8Array(5 * 1_024 * 1_024 + 1), contentType: "image/png" },
      { bytes: new Uint8Array([1]), contentType: "image/svg+xml" },
    ]) {
      await expect(client.uploadProfilePicture(accessToken, invalid as { bytes: Uint8Array; contentType: "image/png" }))
        .rejects.toBeInstanceOf(CoreProfileInvalidInputError);
    }
    expect(attempts).toBe(1);
  });

  it("accepts the documented success statuses for picture mutations and nothing else", async () => {
    const client = new CoreProfileHttpClient(baseUrl);
    for (const status of [200, 201, 204]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(status === 204 ? null : "{}", { status })));
      await expect(client.uploadProfilePicture(accessToken, { bytes: new Uint8Array([1]), contentType: "image/jpeg" }))
        .resolves.toBeUndefined();
    }
    for (const status of [200, 204]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
      await expect(client.deleteProfilePicture(accessToken)).resolves.toBeUndefined();
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
    await expect(client.deleteProfilePicture(accessToken)).rejects.toBeInstanceOf(CoreProfileContractError);
    const deleteCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(deleteCall?.[0]).toEqual(new URL("https://api.yildizskylab.com/v1/users/me/profile-picture"));
    expect(deleteCall?.[1]).toMatchObject({ method: "DELETE", body: null });
  });

  it("maps the fixed error statuses without echoing upstream bodies", async () => {
    const client = new CoreProfileHttpClient(baseUrl);
    const cases = [
      [400, CoreProfileRejectedError],
      [401, CoreProfileUnauthorizedError],
      [403, CoreProfileForbiddenError],
      [404, CoreProfileNotFoundError],
      [413, CoreProfileRejectedError],
      [415, CoreProfileRejectedError],
      [422, CoreProfileRejectedError],
      [429, CoreProfileRejectedError],
      [500, CoreProfileUnavailableError],
      [503, CoreProfileUnavailableError],
    ] as const;
    for (const [status, ErrorType] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream detail", { status })));
      const rejection = client.getMe(accessToken);
      await expect(rejection).rejects.toBeInstanceOf(ErrorType);
      await expect(rejection).rejects.not.toThrow(/secret upstream detail/);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream detail", { status: 429 })));
    await expect(client.getMe(accessToken)).rejects.toMatchObject({ status: 429 });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up secret upstream detail")));
    const transport = client.getMe(accessToken);
    await expect(transport).rejects.toBeInstanceOf(CoreProfileUnavailableError);
    await expect(transport).rejects.not.toThrow(/secret upstream detail/);
  });

  it("fails closed on profile payloads that drift from the pinned me-view", async () => {
    const client = new CoreProfileHttpClient(baseUrl);
    for (const body of [
      { ...meFixture, id: "" },
      { ...meFixture, studentCardLinked: "yes" },
      { ...meFixture, ytuLinked: "true" },
      { ...meFixture, ytuLinked: 1 },
      { ...meFixture, profilePictureUrl: "/media/relative.webp" },
      { ...meFixture, profilePictureUrl: "javascript:alert(1)" },
      { ...meFixture, createdAt: "yesterday" },
      { ...meFixture, phone: 5551112233 },
      Object.fromEntries(Object.entries(meFixture).filter(([key]) => key !== "id")),
      [meFixture],
      "me",
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
      await expect(client.getMe(accessToken)).rejects.toBeInstanceOf(CoreProfileContractError);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(meFixture), {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    await expect(client.getMe(accessToken)).rejects.toBeInstanceOf(CoreProfileContractError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...meFixture, faculty: "x".repeat(20 * 1_024) })));
    await expect(client.getMe(accessToken)).rejects.toBeInstanceOf(CoreProfileContractError);
  });

  it("does not send an empty or malformed bearer", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new CoreProfileHttpClient(baseUrl);
    await expect(client.getMe("")).rejects.toBeInstanceOf(CoreProfileInvalidInputError);
    await expect(client.getMe("token with spaces")).rejects.toBeInstanceOf(CoreProfileInvalidInputError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
