// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import problemsFixture from "../../../tests/fixtures/sky-account-v1-problems.json";
import { PATCH as changeName } from "@/app/api/account/identity/name/route";
import { GET as identity } from "@/app/api/account/identity/route";
import { POST as changeUsername } from "@/app/api/account/identity/username/route";
import { SESSION_COOKIE } from "@/server/auth/http";
import { logAuthEvent } from "@/server/auth/logging";
import { SudoRequiredError } from "@/server/auth/sudo";
import {
  CoreProfileContractError,
  CoreProfileRejectedError,
  CoreProfileUnauthorizedError,
  CoreProfileUnavailableError,
} from "@/server/core/profile-client";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import {
  parseSkyAccountProblem,
  SkyAccountContractError,
  SkyAccountUnavailableError,
} from "@/server/sky-account/problem";

const routeMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateMutation: vi.fn(),
  csrfToken: vi.fn(),
  revokeSession: vi.fn(),
  accessToken: vi.fn(),
  identity: vi.fn(),
  patchName: vi.fn(),
  changeUsername: vi.fn(),
  requireFreshSudo: vi.fn(),
  clearSudo: vi.fn(),
  consumeKey: vi.fn(),
  patchMe: vi.fn(),
  coreEnabled: true,
  config: { appUrl: new URL("https://my.yildizskylab.com") },
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: routeMocks.config,
    sessionAccess: {
      authenticate: routeMocks.authenticate,
      authenticateMutation: routeMocks.authenticateMutation,
    },
    sessions: { csrfToken: routeMocks.csrfToken, revokeSession: routeMocks.revokeSession },
    account: { accessToken: routeMocks.accessToken },
    skyAccount: {
      identity: routeMocks.identity,
      patchName: routeMocks.patchName,
      changeUsername: routeMocks.changeUsername,
    },
    sudo: { requireFreshSudo: routeMocks.requireFreshSudo, clearSudo: routeMocks.clearSudo },
    anonymousRateLimit: { consumeKey: routeMocks.consumeKey },
    coreProfile: routeMocks.coreEnabled ? { patchMe: routeMocks.patchMe } : null,
  }),
}));

const activeSession = {
  id: "11111111-1111-4111-8111-111111111111",
  subject: "authenticated-subject",
  keycloakSid: "sid",
  createdAt: new Date("2026-09-21T12:00:00Z"),
  lastSeenAt: new Date("2026-09-21T13:00:00Z"),
  idleExpiresAt: new Date("2026-09-21T13:30:00Z"),
  absoluteExpiresAt: new Date("2026-09-21T20:00:00Z"),
};
const origin = "https://my.yildizskylab.com";
const sudoToken = "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyJ9.signature-fixture";
const proof = { method: "password", sudoToken, expiresAt: new Date("2026-09-21T13:15:18Z") };
const bearer = { accessToken: "server-held-user-token" };
const unlocked = { ...identityFixture, verifiedYtu: false, nameLocked: false };
const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString();

function problem(code: keyof typeof problemsFixture) {
  const body = problemsFixture[code];
  const mapped = parseSkyAccountProblem(body, body.status, null);
  if (!mapped) throw new Error(`fixture ${code} did not parse`);
  return mapped;
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  origin?: string | null;
  csrf?: string | null;
  contentType?: string | null;
  cookie?: boolean;
};

function request(path: string, body?: unknown, options: RequestOptions = {}) {
  const headers = new Headers();
  if (options.cookie !== false) headers.set("cookie", `${SESSION_COOKIE}=${"h".repeat(43)}`);
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (options.csrf !== null) headers.set("x-csrf-token", options.csrf ?? "session-bound-csrf");
  if (body !== undefined && options.contentType !== null) headers.set("content-type", options.contentType ?? "application/json");
  return new NextRequest(`${origin}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

function read(options: RequestOptions = {}) {
  return identity(request("/api/account/identity", undefined, { method: "GET", origin: null, csrf: null, ...options }));
}

function name(body: unknown, options: RequestOptions = {}) {
  return changeName(request("/api/account/identity/name", body, { method: "PATCH", ...options }));
}

function username(body: unknown, options: RequestOptions = {}) {
  return changeUsername(request("/api/account/identity/username", body, options));
}

async function textOf(response: Response) {
  return `${response.status} ${[...response.headers.entries()].join(";")} ${await response.text()}`;
}

describe("identity BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.coreEnabled = true;
    const active = { status: "active", value: { session: activeSession, rotated: false } };
    routeMocks.authenticate.mockResolvedValue(active);
    routeMocks.authenticateMutation.mockResolvedValue(active);
    routeMocks.csrfToken.mockReturnValue("session-bound-csrf");
    routeMocks.revokeSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.identity.mockResolvedValue(identityFixture);
    routeMocks.patchName.mockImplementation(async (_auth: unknown, input: { firstName: string; lastName: string }) => ({
      ...unlocked,
      ...input,
    }));
    routeMocks.changeUsername.mockResolvedValue({ ...identityFixture, username: "ada.lovelace" });
    routeMocks.requireFreshSudo.mockResolvedValue(proof);
    routeMocks.clearSudo.mockResolvedValue(undefined);
    routeMocks.consumeKey.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 900 });
    routeMocks.patchMe.mockResolvedValue({});
  });

  describe("GET /api/account/identity", () => {
    it("answers the identity view and the CSRF token without subject, personal e-mail, credentials or tokens", async () => {
      const response = await read();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
        nameLocked: true,
        username: "account-fixture",
        usernameChangeAvailableAt: null,
        verifiedYtu: true,
        schoolEmail: "ada@std.yildiz.edu.tr",
        email: "ada@std.yildiz.edu.tr",
        emailVerified: true,
        csrfToken: "session-bound-csrf",
      });
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/ada-personal|2f0c5b4a|server-held|11111111-1111|credentials|Telefon|MacBook/);
      expect(routeMocks.identity).toHaveBeenCalledWith(bearer);
    });

    it("keeps a running username cooldown and drops one that already ended", async () => {
      routeMocks.identity.mockResolvedValue({ ...identityFixture, usernameChangeAvailableAt: inTwoDays });
      await expect((await read()).json()).resolves.toMatchObject({ usernameChangeAvailableAt: inTwoDays });
      routeMocks.identity.mockResolvedValue({ ...identityFixture, usernameChangeAvailableAt: "2026-09-01T00:00:00Z" });
      await expect((await read()).json()).resolves.toMatchObject({ usernameChangeAvailableAt: null });
    });

    it.each([
      ["missing", 401, false],
      ["blocked", 401, true],
      ["unavailable", 503, false],
    ] as const)("answers the %s session outcome with %d", async (status, expected, clears) => {
      routeMocks.authenticate.mockResolvedValue({ status });
      const response = await read();
      expect(response.status).toBe(expected);
      expect(response.cookies.get(SESSION_COOKIE)?.value === "").toBe(clears);
      expect(routeMocks.identity).not.toHaveBeenCalled();
    });

    it("ends the local session when the bearer can no longer be refreshed and maps outages", async () => {
      routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
      const ended = await read();
      expect(ended.status).toBe(401);
      expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);

      routeMocks.accessToken.mockResolvedValue("server-held-user-token");
      routeMocks.identity.mockRejectedValue(new SkyAccountUnavailableError());
      const outage = await read();
      expect(outage.status).toBe(503);
      expect(outage.headers.get("retry-after")).toBe("3");
      await expect(outage.json()).resolves.toMatchObject({ error: "unavailable" });

      routeMocks.identity.mockRejectedValue(new SkyAccountContractError());
      const drift = await read();
      expect(drift.status).toBe(502);
      await expect(drift.json()).resolves.toMatchObject({ error: "upstream_error" });
    });
  });

  describe("PATCH /api/account/identity/name", () => {
    it("forwards the normalised names to the SPI without Sudo mode, then mirrors the accepted names into core", async () => {
      routeMocks.patchName.mockResolvedValue({ ...unlocked, firstName: "Augusta Ada", lastName: "King" });
      const response = await name({ firstName: "  Augusta   Ada ", lastName: "King " });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ coreSync: "synced" });
      expect(routeMocks.patchName).toHaveBeenCalledWith(bearer, { firstName: "Augusta Ada", lastName: "King" });
      expect(routeMocks.patchMe).toHaveBeenCalledWith("server-held-user-token", { firstName: "Augusta Ada", lastName: "King" });
      expect(routeMocks.patchMe.mock.invocationCallOrder[0]).toBeGreaterThan(routeMocks.patchName.mock.invocationCallOrder[0]!);
      expect(routeMocks.requireFreshSudo).not.toHaveBeenCalled();
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("identity_mutation", activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "identity_action",
        outcome: "success",
        identityAction: "name",
      }));
      expect(logAuthEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "identity_name_core_sync_failed" }));
    });

    it("mirrors what the SPI stored, not the raw input, and retries core once with a refreshed token", async () => {
      routeMocks.patchName.mockResolvedValue({ ...unlocked, firstName: "Ada", lastName: "Byron" });
      routeMocks.patchMe.mockRejectedValueOnce(new CoreProfileUnauthorizedError()).mockResolvedValueOnce({});
      routeMocks.accessToken.mockResolvedValueOnce("server-held-user-token").mockResolvedValueOnce("refreshed-user-token");
      const response = await name({ firstName: "Ada", lastName: "Byron" });
      await expect(response.json()).resolves.toEqual({ coreSync: "synced" });
      expect(routeMocks.accessToken).toHaveBeenLastCalledWith(activeSession, { forceRefresh: true });
      expect(routeMocks.patchMe).toHaveBeenNthCalledWith(1, "server-held-user-token", { firstName: "Ada", lastName: "Byron" });
      expect(routeMocks.patchMe).toHaveBeenNthCalledWith(2, "refreshed-user-token", { firstName: "Ada", lastName: "Byron" });
    });

    it.each([
      [new CoreProfileUnavailableError(), "provider_unavailable"],
      [new CoreProfileUnauthorizedError(), "invalid_token"],
      [new CoreProfileContractError(), "contract_blocked"],
      [new CoreProfileRejectedError(400), "core_rejected"],
    ])("keeps the Keycloak change and reports a soft core failure (%s) as coreSync: failed", async (error, reason) => {
      routeMocks.patchMe.mockRejectedValue(error);
      const response = await name({ firstName: "Ada", lastName: "Byron" });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ coreSync: "failed" });
      expect(routeMocks.patchName).toHaveBeenCalledTimes(1);
      expect(logAuthEvent).toHaveBeenCalledWith({
        event: "identity_name_core_sync_failed",
        requestId: "request-id",
        outcome: "failure",
        reason,
      });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "identity_action", outcome: "success" }));
    });

    it("reports coreSync: disabled when this environment has no core", async () => {
      routeMocks.coreEnabled = false;
      const response = await name({ firstName: "Ada", lastName: "Byron" });
      await expect(response.json()).resolves.toEqual({ coreSync: "disabled" });
      expect(routeMocks.patchMe).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "identity_name_core_sync_failed",
        reason: "core_disabled",
      }));
    });

    it("answers 403 name_locked from the SPI for a Verified YTÜ account and never touches core", async () => {
      routeMocks.patchName.mockRejectedValue(problem("name_locked"));
      const response = await name({ firstName: "Ada", lastName: "Byron" });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "name_locked",
        detail: "Doğrulanmış YTÜ hesabının adı YTÜ kaydından gelir ve değiştirilemez.",
      });
      expect(routeMocks.patchMe).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "name_locked", identityAction: "name" }));
    });

    it("refuses invisible, prohibited, empty and over-long names locally with the field named", async () => {
      const cases: Array<[unknown, "firstName" | "lastName", RegExp]> = [
        [{ firstName: "Ada​Lovelace", lastName: "Byron" }, "firstName", /^Ad görünmez/],
        [{ firstName: "Ada", lastName: "Byron King" }, "lastName", /^Soyad görünmez/],
        [{ firstName: "Ada<script>", lastName: "Byron" }, "firstName", /^Ad şu karakterleri içeremez/],
        [{ firstName: "Ada", lastName: "   " }, "lastName", /^Soyad boş olamaz/],
        [{ firstName: "x".repeat(65), lastName: "Byron" }, "firstName", /^Ad en fazla 64 karakter/],
        [{ firstName: "Ada" }, "lastName", /^Soyad boş olamaz/],
        [{ firstName: 42, lastName: "Byron" }, "firstName", /^Ad boş olamaz/],
      ];
      for (const [body, field, detail] of cases) {
        const response = await name(body);
        expect(response.status).toBe(400);
        const answer = await response.json();
        expect(answer).toMatchObject({ error: "invalid_name", field });
        expect(answer.detail).toMatch(detail);
      }
      expect(routeMocks.patchName).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid_name" }));
    });

    it("relays the SPI's own invalid_name with its field", async () => {
      routeMocks.patchName.mockRejectedValue(problem("invalid_name"));
      const response = await name({ firstName: "Ada", lastName: "Byron" });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_name", detail: "Ad boş olamaz.", field: "firstName" });
    });

    it("rejects malformed bodies, wrong origins and missing CSRF before contacting the SPI", async () => {
      const cases: Array<[Promise<Response>, number, string]> = [
        [name(`{"firstName":"Ada"`), 400, "invalid_request"],
        [name("[]"), 400, "invalid_request"],
        [name({ firstName: "Ada", lastName: "x".repeat(5_000) }), 413, "invalid_request"],
        [name({ firstName: "Ada", lastName: "Byron" }, { contentType: "text/plain" }), 400, "invalid_request"],
        [name({ firstName: "Ada", lastName: "Byron" }, { origin: "https://evil.invalid" }), 403, "forbidden"],
        [name({ firstName: "Ada", lastName: "Byron" }, { origin: null }), 403, "forbidden"],
      ];
      routeMocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
      cases.push([name({ firstName: "Ada", lastName: "Byron" }, { csrf: null }), 403, "forbidden"]);
      for (const [answer, status, error] of cases) {
        const response = await answer;
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toMatchObject({ error });
      }
      expect(routeMocks.patchName).not.toHaveBeenCalled();
    });

    it("applies the local budget, maps outages and writes a rotated handle to every answer", async () => {
      routeMocks.consumeKey.mockResolvedValueOnce({ allowed: false, count: 11, retryAfterSeconds: 420 });
      const limited = await name({ firstName: "Ada", lastName: "Byron" });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("420");
      await expect(limited.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 420 });
      expect(routeMocks.patchName).not.toHaveBeenCalled();

      routeMocks.patchName.mockRejectedValueOnce(problem("unmanaged_attributes_enabled"));
      const frozen = await name({ firstName: "Ada", lastName: "Byron" });
      expect(frozen.status).toBe(503);
      expect(frozen.headers.get("retry-after")).toBe("60");
      await expect(frozen.json()).resolves.toMatchObject({ error: "unavailable" });

      routeMocks.authenticateMutation.mockResolvedValueOnce({
        status: "active",
        value: { session: activeSession, rotated: true, rotatedHandle: "rotated-handle-value" },
      });
      routeMocks.patchName.mockRejectedValueOnce(problem("name_locked"));
      const rotated = await name({ firstName: "Ada", lastName: "Byron" });
      expect(rotated.status).toBe(403);
      expect(rotated.cookies.get(SESSION_COOKIE)?.value).toBe("rotated-handle-value");

      routeMocks.patchName.mockRejectedValueOnce(problem("unauthorized"));
      const ended = await name({ firstName: "Ada", lastName: "Byron" });
      expect(ended.status).toBe(401);
      expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);
    });
  });

  describe("POST /api/account/identity/username", () => {
    it("answers 428 sudo_required with the methods before the budget, the body or the SPI", async () => {
      routeMocks.requireFreshSudo.mockRejectedValue(new SudoRequiredError("missing", null));
      const response = await username({ username: "ada.lovelace" });
      expect(response.status).toBe(428);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: "sudo_required",
        reason: "missing",
        methods: ["password", "passkey", "totp"],
        fallback: null,
      });
      expect(routeMocks.changeUsername).not.toHaveBeenCalled();
      expect(routeMocks.consumeKey).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "identity_action",
        outcome: "failure",
        reason: "sudo_required",
        identityAction: "username",
      }));
    });

    it("refuses a Microsoft re-authentication proof with 428 spi_token_required", async () => {
      routeMocks.requireFreshSudo.mockResolvedValue({ method: "reauth", sudoToken: null, expiresAt: proof.expiresAt });
      routeMocks.identity.mockResolvedValue({ ...identityFixture, credentials: { password: false, totp: [], passkeys: [] } });
      const response = await username({ username: "ada.lovelace" });
      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toEqual({
        error: "sudo_required",
        reason: "spi_token_required",
        methods: [],
        fallback: "microsoft",
      });
      expect(routeMocks.changeUsername).not.toHaveBeenCalled();
    });

    it("discards a proof the SPI rejects and re-issues the 428 challenge", async () => {
      routeMocks.changeUsername.mockRejectedValue(problem("sudo_expired"));
      const response = await username({ username: "ada.lovelace" });
      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toEqual({
        error: "sudo_required",
        reason: "expired",
        methods: ["password", "passkey", "totp"],
        fallback: null,
      });
      expect(routeMocks.clearSudo).toHaveBeenCalledWith(activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "sudo_rejected_upstream" }));
    });

    it("forwards the lower-cased username with the sudo token and answers 204", async () => {
      const response = await username({ username: " Ada.Lovelace " });
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(routeMocks.changeUsername).toHaveBeenCalledWith({ ...bearer, sudoToken }, { username: "ada.lovelace" });
      expect(routeMocks.requireFreshSudo).toHaveBeenCalledWith(activeSession.id, { requestId: "request-id" });
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("identity_mutation", activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "identity_action",
        outcome: "success",
        identityAction: "username",
      }));
    });

    it("maps username_taken and username_cooldown to 409 with the SPI detail, retry hints and the cooldown instant", async () => {
      routeMocks.changeUsername.mockRejectedValueOnce(problem("username_taken"));
      const taken = await username({ username: "ada.lovelace" });
      expect(taken.status).toBe(409);
      await expect(taken.json()).resolves.toEqual({
        error: "username_taken",
        detail: "Bu kullanıcı adı kullanılıyor.",
        field: "username",
      });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "username_taken" }));

      routeMocks.changeUsername.mockRejectedValueOnce(problem("username_cooldown"));
      const cooldown = await username({ username: "ada.lovelace" });
      expect(cooldown.status).toBe(409);
      expect(cooldown.headers.get("retry-after")).toBe("604800");
      await expect(cooldown.json()).resolves.toEqual({
        error: "username_cooldown",
        detail: "Kullanıcı adını 14 günde bir değiştirebilirsin.",
        retryAfter: 604800,
        availableAt: "2026-09-28T13:10:41.000Z",
      });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "username_cooldown" }));
    });

    it("refuses usernames outside the pattern locally and relays the SPI's invalid_username", async () => {
      const cases: Array<[unknown, RegExp]> = [
        [{ username: "ab" }, /en az 3 karakter/],
        [{ username: "a".repeat(31) }, /en fazla 30 karakter/],
        [{ username: "ada lovelace" }, /küçük harf/],
        [{ username: "ada-lovelace" }, /küçük harf/],
        [{ username: "" }, /boş olamaz/],
        [{}, /boş olamaz/],
      ];
      for (const [body, detail] of cases) {
        const response = await username(body);
        expect(response.status).toBe(400);
        const answer = await response.json();
        expect(answer).toMatchObject({ error: "invalid_username", field: "username" });
        expect(answer.detail).toMatch(detail);
      }
      expect(routeMocks.changeUsername).not.toHaveBeenCalled();

      routeMocks.changeUsername.mockRejectedValueOnce(problem("invalid_username"));
      const upstream = await username({ username: "ada.lovelace" });
      expect(upstream.status).toBe(400);
      await expect(upstream.json()).resolves.toMatchObject({ error: "invalid_username", field: "username" });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid_username" }));
    });

    it("never echoes names, usernames or tokens in any answer or log", async () => {
      routeMocks.changeUsername.mockRejectedValueOnce(problem("username_taken"));
      routeMocks.patchName.mockRejectedValueOnce(problem("name_locked"));
      const answers = [
        await username({ username: "ada.byron.secret" }),
        await username({ username: "ada.byron.secret" }),
        await username({ username: "ada byron secret" }),
        await name({ firstName: "Augusta Secret", lastName: "Byron Secret" }),
        await name({ firstName: "Augusta Secret", lastName: "Byron Secret" }),
        await name({ firstName: "Augusta​Secret", lastName: "Byron" }),
        await name({ firstName: "Augusta Secret", lastName: "Byron Secret" }, { csrf: null }),
      ];
      for (const answer of answers) {
        const text = await textOf(answer);
        expect(text).not.toMatch(/secret/i);
        expect(text).not.toContain(sudoToken);
        expect(text).not.toContain("server-held-user-token");
      }
      for (const call of vi.mocked(logAuthEvent).mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toMatch(/secret|Augusta|Byron|ada\.byron/i);
        expect(serialized).not.toContain(sudoToken.slice(0, 30));
        expect(serialized).not.toContain("server-held-user-token");
      }
    });
  });
});
