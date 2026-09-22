// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import problemsFixture from "../../../tests/fixtures/sky-account-v1-problems.json";
import { POST as requestChange } from "@/app/api/account/email/change-request/route";
import { POST as confirm } from "@/app/api/account/email/confirm/route";
import { DELETE as removePersonal } from "@/app/api/account/email/personal/route";
import { POST as selectPrimary } from "@/app/api/account/email/primary/route";
import { GET as email } from "@/app/api/account/email/route";
import { SESSION_COOKIE } from "@/server/auth/http";
import { logAuthEvent } from "@/server/auth/logging";
import { SudoRequiredError } from "@/server/auth/sudo";
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
  requestEmailChange: vi.fn(),
  confirmEmail: vi.fn(),
  setPrimaryEmail: vi.fn(),
  removePersonalEmail: vi.fn(),
  requireFreshSudo: vi.fn(),
  clearSudo: vi.fn(),
  consumeKey: vi.fn(),
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
      requestEmailChange: routeMocks.requestEmailChange,
      confirmEmail: routeMocks.confirmEmail,
      setPrimaryEmail: routeMocks.setPrimaryEmail,
      removePersonalEmail: routeMocks.removePersonalEmail,
    },
    sudo: { requireFreshSudo: routeMocks.requireFreshSudo, clearSudo: routeMocks.clearSudo },
    anonymousRateLimit: { consumeKey: routeMocks.consumeKey },
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
const expiresAt = new Date("2026-09-21T13:45:18Z");

function problem(code: keyof typeof problemsFixture, overrides: Record<string, unknown> = {}) {
  const body = { ...problemsFixture[code], ...overrides };
  const mapped = parseSkyAccountProblem(body, body.status, null);
  if (!mapped) throw new Error(`fixture ${code} did not parse`);
  return mapped;
}

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  origin?: string | null;
  csrf?: string | null;
  contentType?: string | null;
};

function request(path: string, body?: unknown, options: RequestOptions = {}) {
  const headers = new Headers();
  headers.set("cookie", `${SESSION_COOKIE}=${"h".repeat(43)}`);
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

function read() {
  return email(request("/api/account/email", undefined, { method: "GET", origin: null, csrf: null }));
}

function change(body: unknown, options: RequestOptions = {}) {
  return requestChange(request("/api/account/email/change-request", body, options));
}

function confirmCode(body: unknown, options: RequestOptions = {}) {
  return confirm(request("/api/account/email/confirm", body, options));
}

function primary(body: unknown, options: RequestOptions = {}) {
  return selectPrimary(request("/api/account/email/primary", body, options));
}

function remove(options: RequestOptions = {}) {
  return removePersonal(request("/api/account/email/personal", undefined, { method: "DELETE", ...options }));
}

async function textOf(response: Response) {
  return `${response.status} ${[...response.headers.entries()].join(";")} ${await response.text()}`;
}

describe("e-mail BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const active = { status: "active", value: { session: activeSession, rotated: false } };
    routeMocks.authenticate.mockResolvedValue(active);
    routeMocks.authenticateMutation.mockResolvedValue(active);
    routeMocks.csrfToken.mockReturnValue("session-bound-csrf");
    routeMocks.revokeSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.identity.mockResolvedValue(identityFixture);
    routeMocks.requestEmailChange.mockResolvedValue({ expiresAt });
    routeMocks.confirmEmail.mockResolvedValue(identityFixture);
    routeMocks.setPrimaryEmail.mockResolvedValue({ ...identityFixture, primary: "personal" });
    routeMocks.removePersonalEmail.mockResolvedValue({ ...identityFixture, personalEmail: null, personalEmailVerified: false });
    routeMocks.requireFreshSudo.mockResolvedValue(proof);
    routeMocks.clearSudo.mockResolvedValue(undefined);
    routeMocks.consumeKey.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 900 });
  });

  describe("GET /api/account/email", () => {
    it("answers both addresses, the primary and the CSRF proof, without subject, names, credentials or tokens", async () => {
      const response = await read();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        email: "ada@std.yildiz.edu.tr",
        emailVerified: true,
        primary: "school",
        schoolEmail: "ada@std.yildiz.edu.tr",
        verifiedYtu: true,
        personalEmail: "ada-personal@example.invalid",
        personalEmailVerified: true,
        csrfToken: "session-bound-csrf",
      });
      expect(JSON.stringify(body)).not.toMatch(/2f0c5b4a|server-held|11111111-1111|credentials|Telefon|MacBook|Lovelace|account-fixture/);
      expect(routeMocks.identity).toHaveBeenCalledWith(bearer);
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
      routeMocks.accessToken.mockRejectedValueOnce(new AccountReauthenticationRequiredError());
      const ended = await read();
      expect(ended.status).toBe(401);
      expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);

      routeMocks.identity.mockRejectedValueOnce(new SkyAccountUnavailableError());
      const outage = await read();
      expect(outage.status).toBe(503);
      expect(outage.headers.get("retry-after")).toBe("3");

      routeMocks.identity.mockRejectedValueOnce(new SkyAccountContractError());
      const drift = await read();
      expect(drift.status).toBe(502);
      await expect(drift.json()).resolves.toMatchObject({ error: "upstream_error" });
    });
  });

  describe("POST /api/account/email/change-request", () => {
    it("answers 428 sudo_required with the methods before the budget, the body or the SPI", async () => {
      routeMocks.requireFreshSudo.mockRejectedValue(new SudoRequiredError("missing", null));
      const response = await change({ address: "ada@example.com" });
      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toEqual({
        error: "sudo_required",
        reason: "missing",
        methods: ["password", "passkey", "totp"],
        fallback: null,
      });
      expect(routeMocks.requestEmailChange).not.toHaveBeenCalled();
      expect(routeMocks.consumeKey).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith({
        event: "email_action",
        requestId: "request-id",
        outcome: "failure",
        reason: "sudo_required",
        addressAction: "change_request",
      });
    });

    it("refuses a Microsoft re-authentication proof without an SPI token with 428 spi_token_required", async () => {
      routeMocks.requireFreshSudo.mockResolvedValue({ method: "reauth", sudoToken: null, expiresAt: proof.expiresAt });
      routeMocks.identity.mockResolvedValue({ ...identityFixture, credentials: { password: false, totp: [], passkeys: [] } });
      const response = await change({ address: "ada@example.com" });
      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toMatchObject({ reason: "spi_token_required", fallback: "microsoft" });
      expect(routeMocks.requestEmailChange).not.toHaveBeenCalled();
    });

    it("forwards the trimmed address with the sudo token and answers the code's deadline", async () => {
      const response = await change({ address: "  Ada@Example.com " });
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ expiresAt: "2026-09-21T13:45:18.000Z" });
      expect(routeMocks.requestEmailChange).toHaveBeenCalledWith({ ...bearer, sudoToken }, { address: "Ada@Example.com" });
      expect(routeMocks.requireFreshSudo).toHaveBeenCalledWith(activeSession.id, { requestId: "request-id" });
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("email_mutation", activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith({
        event: "email_action",
        requestId: "request-id",
        outcome: "success",
        addressAction: "change_request",
      });
    });

    it("refuses what is not an address locally, naming the field", async () => {
      const cases: unknown[] = [
        { address: "" },
        { address: "   " },
        { address: "ada.example.com" },
        { address: "ada lovelace@example.com" },
        { address: `${"a".repeat(250)}@example.com` },
        { address: 42 },
        {},
      ];
      for (const body of cases) {
        const response = await change(body);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: "invalid_address",
          detail: "Geçerli bir e-posta adresi gir.",
          field: "address",
        });
      }
      expect(routeMocks.requestEmailChange).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid_address", addressAction: "change_request" }));
    });

    it("maps a taken, refused or unsendable address and the SPI's hourly budget", async () => {
      routeMocks.requestEmailChange.mockRejectedValueOnce(problem("email_taken"));
      const taken = await change({ address: "ada@example.com" });
      expect(taken.status).toBe(409);
      await expect(taken.json()).resolves.toEqual({
        error: "email_taken",
        detail: "Bu e-posta adresi başka bir hesapta kayıtlı. Başka bir adres dene.",
        field: "address",
      });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "email_taken" }));

      routeMocks.requestEmailChange.mockRejectedValueOnce(problem("invalid_request", { field: "address" }));
      const refused = await change({ address: "ada@std.yildiz.edu.tr" });
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toEqual({
        error: "invalid_address",
        detail: "Bu adres kullanılamıyor: geçerli bir e-posta adresi değil ya da zaten hesabında kayıtlı.",
        field: "address",
      });

      routeMocks.requestEmailChange.mockRejectedValueOnce(problem("email_not_sent"));
      const unsent = await change({ address: "ada@example.com" });
      expect(unsent.status).toBe(503);
      expect(unsent.headers.get("retry-after")).toBe("60");
      await expect(unsent.json()).resolves.toEqual({
        error: "email_not_sent",
        detail: "Doğrulama e-postası gönderilemedi. Lütfen daha sonra tekrar dene.",
      });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "email_not_sent" }));

      routeMocks.requestEmailChange.mockRejectedValueOnce(problem("rate_limited"));
      const limited = await change({ address: "ada@example.com" });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("540");
      await expect(limited.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 540 });
    });

    it("discards a proof the SPI rejects and re-issues the 428 challenge", async () => {
      routeMocks.requestEmailChange.mockRejectedValue(problem("sudo_expired"));
      const response = await change({ address: "ada@example.com" });
      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toMatchObject({ error: "sudo_required", reason: "expired" });
      expect(routeMocks.clearSudo).toHaveBeenCalledWith(activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "sudo_rejected_upstream" }));
    });

    it("rejects malformed bodies, wrong origins and a missing CSRF proof before contacting the SPI", async () => {
      const cases: Array<[Promise<Response>, number, string]> = [
        [change(`{"address":"ada@example.com"`), 400, "invalid_request"],
        [change("[]"), 400, "invalid_request"],
        [change({ address: `${"a".repeat(5_000)}@example.com` }), 413, "invalid_request"],
        [change({ address: "ada@example.com" }, { contentType: "text/plain" }), 400, "invalid_request"],
        [change({ address: "ada@example.com" }, { origin: "https://evil.invalid" }), 403, "forbidden"],
        [change({ address: "ada@example.com" }, { origin: null }), 403, "forbidden"],
      ];
      routeMocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
      cases.push([change({ address: "ada@example.com" }, { csrf: null }), 403, "forbidden"]);
      for (const [answer, status, error] of cases) {
        const response = await answer;
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toMatchObject({ error });
      }
      expect(routeMocks.requestEmailChange).not.toHaveBeenCalled();
    });

    it("applies the local budget before the body and writes a rotated handle to every answer", async () => {
      routeMocks.consumeKey.mockResolvedValueOnce({ allowed: false, count: 11, retryAfterSeconds: 420 });
      const limited = await change({ address: "ada@example.com" });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("420");
      await expect(limited.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 420 });
      expect(routeMocks.requestEmailChange).not.toHaveBeenCalled();

      routeMocks.authenticateMutation.mockResolvedValueOnce({
        status: "active",
        value: { session: activeSession, rotated: true, rotatedHandle: "rotated-handle-value" },
      });
      routeMocks.requestEmailChange.mockRejectedValueOnce(problem("email_taken"));
      const rotated = await change({ address: "ada@example.com" });
      expect(rotated.status).toBe(409);
      expect(rotated.cookies.get(SESSION_COOKIE)?.value).toBe("rotated-handle-value");

      routeMocks.requestEmailChange.mockRejectedValueOnce(problem("unauthorized"));
      const ended = await change({ address: "ada@example.com" });
      expect(ended.status).toBe(401);
      expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);
    });
  });

  describe("POST /api/account/email/confirm", () => {
    it("confirms with the session only, dropping the spaces of a copied code", async () => {
      const response = await confirmCode({ code: "123 456" });
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(routeMocks.confirmEmail).toHaveBeenCalledWith(bearer, { code: "123456" });
      expect(routeMocks.requireFreshSudo).not.toHaveBeenCalled();
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("email_confirm", activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith({
        event: "email_action",
        requestId: "request-id",
        outcome: "success",
        addressAction: "confirm",
      });
    });

    it("refuses anything but six digits locally, so no attempt is spent", async () => {
      for (const body of [{ code: "12345" }, { code: "1234567" }, { code: "12a456" }, { code: "" }, { code: 123456 }, {}]) {
        const response = await confirmCode(body);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: "invalid_request",
          detail: "Doğrulama kodu 6 rakamdan oluşur.",
          field: "code",
        });
      }
      expect(routeMocks.confirmEmail).not.toHaveBeenCalled();
    });

    it("relays a wrong code with the tries left and tells an exhausted code apart in the log", async () => {
      routeMocks.confirmEmail.mockRejectedValueOnce(problem("invalid_email_code"));
      const wrong = await confirmCode({ code: "000000" });
      expect(wrong.status).toBe(400);
      await expect(wrong.json()).resolves.toEqual({
        error: "invalid_code",
        detail: "Doğrulama kodu yanlış. 4 deneme hakkın kaldı.",
        attemptsLeft: 4,
      });
      expect(logAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "invalid_code", addressAction: "confirm" }));

      routeMocks.confirmEmail.mockRejectedValueOnce(problem("invalid_email_code", {
        attemptsLeft: 0,
        detail: "Doğrulama kodu yanlış ve deneme hakkın bitti. Yeni bir kod iste.",
      }));
      const exhausted = await confirmCode({ code: "000000" });
      expect(exhausted.status).toBe(400);
      await expect(exhausted.json()).resolves.toMatchObject({ error: "invalid_code", attemptsLeft: 0 });
      expect(logAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "code_exhausted" }));
    });

    it("maps a missing or expired change, an address taken meanwhile and the local budget", async () => {
      routeMocks.confirmEmail.mockRejectedValueOnce(problem("no_pending_email_change"));
      const missing = await confirmCode({ code: "123456" });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toEqual({
        error: "no_pending_change",
        detail: "Bekleyen bir doğrulama kodu yok: süresi dolmuş ya da zaten kullanılmış olabilir. Yeni bir kod iste.",
      });
      expect(logAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "no_pending_change" }));

      routeMocks.confirmEmail.mockRejectedValueOnce(problem("email_taken"));
      const taken = await confirmCode({ code: "123456" });
      expect(taken.status).toBe(409);
      await expect(taken.json()).resolves.toMatchObject({ error: "email_taken" });

      routeMocks.consumeKey.mockResolvedValueOnce({ allowed: false, count: 11, retryAfterSeconds: 300 });
      const limited = await confirmCode({ code: "123456" });
      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 300 });
      expect(routeMocks.confirmEmail).toHaveBeenCalledTimes(2);
    });
  });

  describe("POST /api/account/email/primary", () => {
    it("answers 428 before anything else and forwards the choice under sudo", async () => {
      routeMocks.requireFreshSudo.mockRejectedValueOnce(new SudoRequiredError("expired", null));
      const challenged = await primary({ which: "personal" });
      expect(challenged.status).toBe(428);
      expect(routeMocks.setPrimaryEmail).not.toHaveBeenCalled();

      const response = await primary({ which: "personal" });
      expect(response.status).toBe(204);
      expect(routeMocks.setPrimaryEmail).toHaveBeenCalledWith({ ...bearer, sudoToken }, { which: "personal" });
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("email_mutation", activeSession.id);
      expect(logAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "success", addressAction: "primary" }));
    });

    it("refuses a choice that is neither address locally", async () => {
      for (const body of [{ which: "work" }, { which: "" }, { which: 1 }, {}]) {
        const response = await primary(body);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: "invalid_request", field: "which" });
      }
      expect(routeMocks.setPrimaryEmail).not.toHaveBeenCalled();
    });

    it("explains an unproven address in its own words instead of the SPI's link wording", async () => {
      routeMocks.setPrimaryEmail.mockRejectedValueOnce(problem("email_not_verified"));
      const school = await primary({ which: "school" });
      expect(school.status).toBe(409);
      await expect(school.json()).resolves.toEqual({
        error: "email_not_verified",
        detail: "Okul e-postan, YTÜ hesabın bağlanmadan birincil adres yapılamaz. YTÜ hesabını Kimlik sayfasından bağlayabilirsin.",
      });

      routeMocks.setPrimaryEmail.mockRejectedValueOnce(problem("email_not_verified"));
      const personal = await primary({ which: "personal" });
      expect(personal.status).toBe(409);
      const answer = await personal.json();
      expect(answer).toEqual({
        error: "email_not_verified",
        detail: "Kişisel e-postan doğrulanmadığı için birincil adres yapılamaz. Adresi kaldırıp yeniden ekle ve gelen kodla doğrula.",
      });
      expect(JSON.stringify(answer)).not.toContain("bağlantıyla");
      expect(logAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "email_not_verified", addressAction: "primary" }));
    });
  });

  describe("DELETE /api/account/email/personal", () => {
    it("removes the personal address under sudo and answers 204", async () => {
      const response = await remove();
      expect(response.status).toBe(204);
      expect(routeMocks.removePersonalEmail).toHaveBeenCalledWith({ ...bearer, sudoToken });
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("email_mutation", activeSession.id);
      expect(logAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "success", addressAction: "remove" }));
    });

    it("answers 428 without sudo and explains why a primary personal address without a fallback stays", async () => {
      routeMocks.requireFreshSudo.mockRejectedValueOnce(new SudoRequiredError("missing", null));
      expect((await remove()).status).toBe(428);
      expect(routeMocks.removePersonalEmail).not.toHaveBeenCalled();

      routeMocks.removePersonalEmail.mockRejectedValueOnce(problem("no_fallback_email"));
      const kept = await remove();
      expect(kept.status).toBe(409);
      await expect(kept.json()).resolves.toEqual({
        error: "no_fallback_email",
        detail: "Kişisel e-postan birincil adresin ve yerine geçebilecek doğrulanmış bir okul e-postan yok; kaldırırsan giriş yapabileceğin bir adres kalmaz. Önce YTÜ hesabını bağla ve okul e-postanı birincil yap.",
      });
      expect(logAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "no_fallback_email", addressAction: "remove" }));
    });

    it("refuses a foreign origin before the session is read", async () => {
      const response = await remove({ origin: "https://evil.invalid" });
      expect(response.status).toBe(403);
      expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();
      expect(routeMocks.removePersonalEmail).not.toHaveBeenCalled();
    });
  });

  it("never echoes an address or a code in any answer or log", async () => {
    routeMocks.requestEmailChange.mockRejectedValueOnce(problem("email_taken"));
    routeMocks.confirmEmail.mockRejectedValueOnce(problem("invalid_email_code"));
    routeMocks.confirmEmail.mockRejectedValueOnce(problem("no_pending_email_change"));
    const answers = [
      await change({ address: "secret.person@example.com" }),
      await change({ address: "secret.person@example.com" }),
      await change({ address: "secret person@example.com" }),
      await change({ address: "secret.person@example.com" }, { csrf: null, origin: "https://evil.invalid" }),
      await confirmCode({ code: "987654" }),
      await confirmCode({ code: "987654" }),
      await confirmCode({ code: "98765" }),
      await confirmCode({ code: "987654" }),
    ];
    for (const answer of answers) {
      const text = await textOf(answer);
      expect(text).not.toMatch(/secret/i);
      expect(text).not.toMatch(/98765/);
      expect(text).not.toContain(sudoToken);
      expect(text).not.toContain("server-held-user-token");
    }
    for (const call of vi.mocked(logAuthEvent).mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toMatch(/secret|example\.com|98765/i);
      expect(serialized).not.toContain(sudoToken.slice(0, 30));
      expect(serialized).not.toContain("server-held-user-token");
    }
  });
});
