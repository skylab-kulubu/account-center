// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import meFixture from "../../../tests/fixtures/core-users-me.json";
import { GET, PATCH } from "@/app/api/account/club-profile/route";
import { DELETE, POST } from "@/app/api/account/club-profile/picture/route";
import { CLUB_PROFILE_PICTURE_MAX_BYTES } from "@/config/club-profile";
import { SESSION_COOKIE } from "@/server/auth/http";
import {
  CoreProfileContractError,
  CoreProfileForbiddenError,
  CoreProfileNotFoundError,
  CoreProfileRejectedError,
  CoreProfileUnauthorizedError,
  CoreProfileUnavailableError,
} from "@/server/core/profile-client";
import type { CoreProfile } from "@/server/core/profile-client";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";

const profile: CoreProfile = { ...meFixture, studentCardLinked: true };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const routeMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateMutation: vi.fn(),
  csrfToken: vi.fn(),
  revokeLocalSession: vi.fn(),
  accessToken: vi.fn(),
  getMe: vi.fn(),
  patchMe: vi.fn(),
  uploadProfilePicture: vi.fn(),
  deleteProfilePicture: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => routeMocks.services,
}));

const activeSession = {
  id: "local-session-id",
  subject: "authenticated-subject",
  absoluteExpiresAt: new Date("2026-09-22T20:00:00Z"),
};

function buildServices(options: { coreEnabled?: boolean } = {}) {
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: {
      authenticate: routeMocks.authenticate,
      authenticateMutation: routeMocks.authenticateMutation,
    },
    sessions: {
      csrfToken: routeMocks.csrfToken,
      revokeSession: routeMocks.revokeLocalSession,
    },
    account: { accessToken: routeMocks.accessToken },
    coreProfile: options.coreEnabled === false
      ? null
      : {
          getMe: routeMocks.getMe,
          patchMe: routeMocks.patchMe,
          uploadProfilePicture: routeMocks.uploadProfilePicture,
          deleteProfilePicture: routeMocks.deleteProfilePicture,
        },
  };
}

type RequestOptions = {
  method?: string;
  origin?: string;
  csrf?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
};

function request(path = "/api/account/club-profile", options: RequestOptions = {}) {
  const headers = new Headers({ cookie: "__Host-sky-account=opaque-browser-handle", ...options.headers });
  if (options.origin) {
    headers.set("origin", options.origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  return new NextRequest(`https://my.yildizskylab.com${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ?? null,
  });
}

function patchRequest(body: unknown, overrides: RequestOptions = {}) {
  return request("/api/account/club-profile", {
    method: "PATCH",
    origin: "https://my.yildizskylab.com",
    csrf: "session-bound-csrf",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...overrides,
    headers: { "content-type": "application/json", ...overrides.headers },
  });
}

async function multipartRequest(
  parts: Array<{ name: string; value: string | Uint8Array; fileName?: string; type?: string }>,
  overrides: RequestOptions = {},
) {
  const form = new FormData();
  for (const part of parts) {
    if (typeof part.value === "string") form.set(part.name, part.value);
    else form.set(part.name, new File([Buffer.from(part.value)], part.fileName ?? "picture", { type: part.type ?? "" }));
  }
  const encoded = new Request("https://my.yildizskylab.com/api/account/club-profile/picture", { method: "POST", body: form });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  return request("/api/account/club-profile/picture", {
    method: "POST",
    origin: "https://my.yildizskylab.com",
    csrf: "session-bound-csrf",
    body: bytes,
    ...overrides,
    headers: { "content-type": encoded.headers.get("content-type")!, ...overrides.headers },
  });
}

function deleteRequest(overrides: RequestOptions = {}) {
  return request("/api/account/club-profile/picture", {
    method: "DELETE",
    origin: "https://my.yildizskylab.com",
    csrf: "session-bound-csrf",
    ...overrides,
  });
}

const expectedView = {
  skyNumber: "SKY-0000042",
  studentCardLinked: true,
  schoolEmail: "ada@std.yildiz.edu.tr",
  phone: "+905551112233",
  university: "Yıldız Teknik Üniversitesi",
  faculty: "Elektrik-Elektronik Fakültesi",
  department: "Bilgisayar Mühendisliği",
  linkedin: "https://www.linkedin.com/in/ada-lovelace",
  profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/7c1e0a2b-5d6f-4a8b-9c0d-000000000002.webp",
  ytuLinked: false,
  updatedAt: "2026-09-21T13:10:41.130Z",
};

describe("club-profile BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.services = buildServices();
    const active = { status: "active", value: { session: activeSession, rotated: false } };
    routeMocks.authenticate.mockResolvedValue(active);
    routeMocks.authenticateMutation.mockResolvedValue(active);
    routeMocks.csrfToken.mockReturnValue("session-bound-csrf");
    routeMocks.revokeLocalSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.getMe.mockResolvedValue(profile);
    routeMocks.patchMe.mockImplementation(async (_token: string, patch: Record<string, string>) => ({ ...profile, ...patch }));
    routeMocks.uploadProfilePicture.mockResolvedValue(undefined);
    routeMocks.deleteProfilePicture.mockResolvedValue(undefined);
  });

  describe("GET /api/account/club-profile", () => {
    it("returns the browser-safe profile and a session-bound mutation proof", async () => {
      const response = await GET(request());

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({ profile: expectedView, csrfToken: "session-bound-csrf" });
      expect(JSON.stringify(body)).not.toContain(meFixture.id);
      expect(routeMocks.accessToken).toHaveBeenCalledWith(activeSession);
      expect(routeMocks.getMe).toHaveBeenCalledWith("server-held-user-token");
    });

    it("reports the disabled state as a problem when CORE_API_URL is unset", async () => {
      routeMocks.services = buildServices({ coreEnabled: false });

      const response = await GET(request());

      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      await expect(response.json()).resolves.toMatchObject({
        type: "https://my.yildizskylab.com/problems/club-profile-disabled",
        title: "Kulüp profili bu ortamda kapalı",
        instance: "/api/account/club-profile",
      });
      expect(routeMocks.getMe).not.toHaveBeenCalled();
    });

    it.each(["missing", "blocked", "unavailable"] as const)("does not read core when local authorization is %s", async (status) => {
      routeMocks.authenticate.mockResolvedValue({ status });

      const response = await GET(request());

      expect(response.status).toBe(status === "unavailable" ? 503 : 401);
      expect(routeMocks.getMe).not.toHaveBeenCalled();
      if (status === "blocked") expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    });

    it.each([
      [new CoreProfileUnavailableError(), 503, "Kulüp profiline şu anda ulaşılamıyor"],
      [new CoreProfileContractError(), 502, "Kulüp profili güvenle durduruldu"],
      [new CoreProfileForbiddenError(), 403, "Kulüp profili işlemine izin verilmedi"],
      [new CoreProfileNotFoundError(), 404, "Kulüp profili bulunamadı"],
    ])("maps %s to a no-store problem without upstream detail", async (error, status, title) => {
      routeMocks.getMe.mockRejectedValue(error);

      const response = await GET(request());

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ title, status, instance: "/api/account/club-profile" });
      expect(routeMocks.revokeLocalSession).not.toHaveBeenCalled();
    });

    it("keeps the local session when core itself rejects the bearer twice", async () => {
      routeMocks.getMe.mockRejectedValue(new CoreProfileUnauthorizedError());

      const response = await GET(request());

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        type: "https://my.yildizskylab.com/problems/club-profile-reauthentication",
      });
      expect(routeMocks.accessToken).toHaveBeenNthCalledWith(2, activeSession, { forceRefresh: true });
      expect(routeMocks.revokeLocalSession).not.toHaveBeenCalled();
      expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    });

    it("revokes the local session when the Keycloak token cannot be refreshed", async () => {
      routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());

      const response = await GET(request());

      expect(response.status).toBe(401);
      expect(routeMocks.revokeLocalSession).toHaveBeenCalledWith(activeSession.id);
      expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.getMe).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/account/club-profile", () => {
    it("requires the exact configured origin before authenticating", async () => {
      for (const origin of [
        "https://attacker.invalid",
        "https://my.yildizskylab.com/",
        "https://my.yildizskylab.com/path",
        "https://user@my.yildizskylab.com",
        "https://my.yildizskylab.com:443",
      ]) {
        const response = await PATCH(patchRequest({ faculty: "Makine Fakültesi" }, { origin }));
        expect(response.status, origin).toBe(403);
      }
      const response = await PATCH(patchRequest({ faculty: "Makine Fakültesi" }, { origin: undefined }));
      expect(response.status).toBe(403);
      expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();
      expect(routeMocks.getMe).not.toHaveBeenCalled();
    });

    it("rejects an invalid session-bound mutation proof before touching core", async () => {
      routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });

      const response = await PATCH(patchRequest({ faculty: "Makine Fakültesi" }, { csrf: "wrong-proof" }));

      expect(response.status).toBe(403);
      expect(routeMocks.getMe).not.toHaveBeenCalled();
      expect(routeMocks.patchMe).not.toHaveBeenCalled();
    });

    it.each(["missing", "blocked", "unavailable"] as const)("does not write when local authorization is %s", async (status) => {
      routeMocks.authenticateMutation.mockResolvedValue({ status });

      const response = await PATCH(patchRequest({ faculty: "Makine Fakültesi" }));

      expect(response.status).toBe(status === "unavailable" ? 503 : 401);
      expect(routeMocks.patchMe).not.toHaveBeenCalled();
    });

    it("forwards only the changed fields and delivers a rotated handle", async () => {
      routeMocks.authenticateMutation.mockResolvedValue({
        status: "active",
        value: { session: activeSession, rotated: true, rotatedHandle: "n".repeat(43) },
      });

      const response = await PATCH(patchRequest({
        university: "Yıldız Teknik Üniversitesi",
        faculty: " Makine Fakültesi ",
        department: "Bilgisayar Mühendisliği",
        linkedin: "https://www.linkedin.com/in/ada-lovelace",
      }));

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        changed: true,
        profile: { ...expectedView, faculty: "Makine Fakültesi" },
      });
      expect(routeMocks.patchMe).toHaveBeenCalledTimes(1);
      expect(routeMocks.patchMe).toHaveBeenCalledWith("server-held-user-token", { faculty: "Makine Fakültesi" });
      expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
    });

    it("reports an unchanged form without a core write", async () => {
      const response = await PATCH(patchRequest({ faculty: "Elektrik-Elektronik Fakültesi", linkedin: "https://www.linkedin.com/in/ada-lovelace" }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ changed: false, profile: expectedView });
      expect(routeMocks.patchMe).not.toHaveBeenCalled();
    });

    it("clears a field with an empty value", async () => {
      const response = await PATCH(patchRequest({ linkedin: "" }));

      expect(response.status).toBe(200);
      expect(routeMocks.patchMe).toHaveBeenCalledWith("server-held-user-token", { linkedin: "" });
    });

    it("answers an oversized JSON body with a generic 413 rather than the picture copy", async () => {
      for (const candidate of [
        patchRequest({ faculty: "x".repeat(5_000) }),
        patchRequest({ faculty: "x" }, { headers: { "content-length": "5000" } }),
      ]) {
        const response = await PATCH(candidate);
        expect(response.status).toBe(413);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        const body = await response.json();
        expect(body).toMatchObject({
          type: "https://my.yildizskylab.com/problems/club-profile-request-too-large",
          title: "İstek çok büyük",
          status: 413,
        });
        expect(body.title).not.toContain("Fotoğraf");
        expect(body.detail).not.toContain("PNG");
      }
      expect(routeMocks.getMe).not.toHaveBeenCalled();
    });

    it("rejects malformed bodies and never reads core for them", async () => {
      const cases: Array<[NextRequest, number, string | undefined]> = [
        [patchRequest("{not json", {}), 400, undefined],
        [patchRequest({ faculty: "x" }, { headers: { "content-type": "text/plain" } }), 400, undefined],
        [patchRequest({ faculty: "x".repeat(5_000) }), 413, undefined],
        [patchRequest({ firstName: "Ada", faculty: "x" }), 400, undefined],
        [patchRequest({ phone: "+905550000000" }), 400, undefined],
        [patchRequest({ linkedin: "http://www.linkedin.com/in/ada" }), 400, "linkedin"],
        [patchRequest({ linkedin: "https://tr.linkedin.com/in/ada" }), 400, "linkedin"],
        [patchRequest({ department: "x".repeat(121) }), 400, "department"],
        [patchRequest({ university: 42 }), 400, "university"],
        [patchRequest([]), 400, undefined],
      ];
      for (const [candidate, status, field] of cases) {
        const response = await PATCH(candidate);
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        const body = await response.json();
        if (field) expect(body.field).toBe(field);
        else expect(body.field).toBeUndefined();
      }
      expect(routeMocks.getMe).not.toHaveBeenCalled();
      expect(routeMocks.patchMe).not.toHaveBeenCalled();
    });

    it("answers 409 for a YTÜ field change of a YTÜ-linked person and leaves core untouched", async () => {
      routeMocks.getMe.mockResolvedValue({ ...profile, ytuLinked: true });

      const response = await PATCH(patchRequest({ department: "Fizik", linkedin: "" }));

      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      await expect(response.json()).resolves.toMatchObject({
        type: "https://my.yildizskylab.com/problems/club-profile-ytu-managed",
        title: "Bu bilgi YTÜ hesabından gelir",
        status: 409,
        field: "department",
      });
      expect(routeMocks.patchMe).not.toHaveBeenCalled();
    });

    it("maps core's own 409 for a YTÜ field to the same problem", async () => {
      routeMocks.patchMe.mockRejectedValue(new CoreProfileRejectedError(409));

      const response = await PATCH(patchRequest({ faculty: "Makine Fakültesi" }));

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ type: "https://my.yildizskylab.com/problems/club-profile-ytu-managed", status: 409 });
      expect(body.field).toBeUndefined();
    });

    it.each([
      [new CoreProfileRejectedError(429), 429, "Çok fazla deneme"],
      [new CoreProfileRejectedError(400), 400, "Core isteği kabul etmedi"],
      [new CoreProfileRejectedError(422), 400, "Core isteği kabul etmedi"],
      [new CoreProfileUnavailableError(), 503, "Kulüp profiline şu anda ulaşılamıyor"],
      [new CoreProfileForbiddenError(), 403, "Kulüp profili işlemine izin verilmedi"],
    ])("maps a core write failure %s to %i", async (error, status, title) => {
      routeMocks.patchMe.mockRejectedValue(error);

      const response = await PATCH(patchRequest({ faculty: "Makine Fakültesi" }));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ title, status });
      expect(routeMocks.revokeLocalSession).not.toHaveBeenCalled();
    });

    it("answers the disabled state after authentication", async () => {
      routeMocks.services = buildServices({ coreEnabled: false });

      const response = await PATCH(patchRequest({ faculty: "Makine Fakültesi" }));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ title: "Kulüp profili bu ortamda kapalı" });
      expect(routeMocks.authenticateMutation).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/account/club-profile/picture", () => {
    it("forwards a sniffed PNG under the pinned field and re-reads the profile", async () => {
      const uploaded = { ...profile, profilePictureId: "new", profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/new.png" };
      routeMocks.getMe.mockResolvedValue(uploaded);

      const response = await POST(await multipartRequest([
        { name: "file", value: png, fileName: "me.png", type: "image/png" },
      ]));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        profile: { ...expectedView, profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/new.png" },
      });
      expect(routeMocks.uploadProfilePicture).toHaveBeenCalledWith("server-held-user-token", {
        bytes: png,
        contentType: "image/png",
      });
      expect(routeMocks.getMe).toHaveBeenCalledTimes(1);
    });

    it("trusts the bytes rather than the declared type", async () => {
      const response = await POST(await multipartRequest([
        { name: "file", value: png, fileName: "me.jpg", type: "image/jpeg" },
      ]));

      expect(response.status).toBe(200);
      expect(routeMocks.uploadProfilePicture).toHaveBeenCalledWith("server-held-user-token", {
        bytes: png,
        contentType: "image/png",
      });
    });

    it("rejects unsupported, empty, oversize and malformed uploads before core", async () => {
      const disguisedSvg = await POST(await multipartRequest([
        { name: "file", value: svg, fileName: "me.png", type: "image/png" },
      ]));
      expect(disguisedSvg.status).toBe(415);
      await expect(disguisedSvg.json()).resolves.toMatchObject({ title: "Dosya türü desteklenmiyor" });

      const empty = await POST(await multipartRequest([
        { name: "file", value: new Uint8Array(0), fileName: "empty.png", type: "image/png" },
      ]));
      expect(empty.status).toBe(400);

      const declaredOversize = await POST(await multipartRequest(
        [{ name: "file", value: png, fileName: "me.png", type: "image/png" }],
        { headers: { "content-length": String(CLUB_PROFILE_PICTURE_MAX_BYTES + 64 * 1_024 + 1) } },
      ));
      expect(declaredOversize.status).toBe(413);
      await expect(declaredOversize.json()).resolves.toMatchObject({ title: "Fotoğraf çok büyük", status: 413 });

      const oversizeFile = new Uint8Array(CLUB_PROFILE_PICTURE_MAX_BYTES + 1);
      oversizeFile.set(png);
      const streamedOversize = await POST(await multipartRequest([
        { name: "file", value: oversizeFile, fileName: "big.png", type: "image/png" },
      ]));
      expect(streamedOversize.status).toBe(413);
      await expect(streamedOversize.json()).resolves.toMatchObject({ title: "Fotoğraf çok büyük" });

      const wrongField = await POST(await multipartRequest([
        { name: "image", value: png, fileName: "me.png", type: "image/png" },
      ]));
      expect(wrongField.status).toBe(400);

      const notMultipart = await POST(request("/api/account/club-profile/picture", {
        method: "POST",
        origin: "https://my.yildizskylab.com",
        csrf: "session-bound-csrf",
        headers: { "content-type": "application/octet-stream" },
        body: png,
      }));
      expect(notMultipart.status).toBe(400);

      expect(routeMocks.uploadProfilePicture).not.toHaveBeenCalled();
      expect(routeMocks.getMe).not.toHaveBeenCalled();
    });

    it("requires exact origin and CSRF like every other mutation", async () => {
      const foreign = await POST(await multipartRequest(
        [{ name: "file", value: png, fileName: "me.png", type: "image/png" }],
        { origin: "https://attacker.invalid" },
      ));
      expect(foreign.status).toBe(403);
      expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();

      routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
      const forged = await POST(await multipartRequest(
        [{ name: "file", value: png, fileName: "me.png", type: "image/png" }],
        { csrf: "forged" },
      ));
      expect(forged.status).toBe(403);
      expect(routeMocks.uploadProfilePicture).not.toHaveBeenCalled();
    });

    it.each([
      [new CoreProfileRejectedError(413), 413, "Fotoğraf çok büyük"],
      [new CoreProfileRejectedError(415), 415, "Dosya türü desteklenmiyor"],
      [new CoreProfileUnavailableError(), 503, "Kulüp profiline şu anda ulaşılamıyor"],
    ])("maps a core upload failure %s to %i", async (error, status, title) => {
      routeMocks.uploadProfilePicture.mockRejectedValue(error);

      const response = await POST(await multipartRequest([
        { name: "file", value: png, fileName: "me.png", type: "image/png" },
      ]));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ title });
      expect(routeMocks.getMe).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/account/club-profile/picture", () => {
    it("removes the picture through core and re-reads the profile", async () => {
      const cleared = { ...profile, profilePictureId: null, profilePictureUrl: null };
      routeMocks.getMe.mockResolvedValue(cleared);

      const response = await DELETE(deleteRequest());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ profile: { ...expectedView, profilePictureUrl: null } });
      expect(routeMocks.deleteProfilePicture).toHaveBeenCalledWith("server-held-user-token");
    });

    it("requires exact origin, a valid proof and an active session", async () => {
      expect((await DELETE(deleteRequest({ origin: "https://attacker.invalid" }))).status).toBe(403);
      routeMocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
      expect((await DELETE(deleteRequest({ csrf: "forged" }))).status).toBe(403);
      routeMocks.authenticateMutation.mockResolvedValueOnce({ status: "missing" });
      expect((await DELETE(deleteRequest())).status).toBe(401);
      expect(routeMocks.deleteProfilePicture).not.toHaveBeenCalled();
    });

    it("answers the disabled state and core failures as problems", async () => {
      routeMocks.services = buildServices({ coreEnabled: false });
      expect((await DELETE(deleteRequest())).status).toBe(503);

      routeMocks.services = buildServices();
      routeMocks.deleteProfilePicture.mockRejectedValue(new CoreProfileUnavailableError());
      const response = await DELETE(deleteRequest());
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ title: "Kulüp profiline şu anda ulaşılamıyor" });
    });
  });
});
