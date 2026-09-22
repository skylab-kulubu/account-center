// @vitest-environment node

import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import passkeyCredentialFixture from "../../../tests/fixtures/sky-account-v1-passkey-credential.json";
import problemsFixture from "../../../tests/fixtures/sky-account-v1-problems.json";
import totpCredentialFixture from "../../../tests/fixtures/sky-account-v1-totp-credential.json";
import totpSetupFixture from "../../../tests/fixtures/sky-account-v1-totp-setup.json";
import attestationJson from "../../../tests/fixtures/sky-account-v1-webauthn-attestation.json";
import registrationOptionsFixture from "../../../tests/fixtures/sky-account-v1-webauthn-registration-options.json";
import { DELETE as deleteCredential } from "@/app/api/account/security/credentials/[reference]/route";
import { POST as passkeyOptions } from "@/app/api/account/security/passkeys/options/route";
import { POST as passkeyRegister } from "@/app/api/account/security/passkeys/register/route";
import { POST as changePassword } from "@/app/api/account/security/password/route";
import { GET as security } from "@/app/api/account/security/route";
import { POST as totpConfirm } from "@/app/api/account/security/totp/confirm/route";
import { POST as totpSetup } from "@/app/api/account/security/totp/setup/route";
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
  credentialReference: vi.fn(),
  revokeSession: vi.fn(),
  accessToken: vi.fn(),
  identity: vi.fn(),
  changePassword: vi.fn(),
  totpSetup: vi.fn(),
  totpConfirm: vi.fn(),
  webauthnRegistrationOptions: vi.fn(),
  registerPasskey: vi.fn(),
  deleteCredential: vi.fn(),
  requireFreshSudo: vi.fn(),
  currentSudo: vi.fn(),
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
    sessions: {
      csrfToken: routeMocks.csrfToken,
      credentialReference: routeMocks.credentialReference,
      revokeSession: routeMocks.revokeSession,
    },
    account: { accessToken: routeMocks.accessToken },
    skyAccount: {
      identity: routeMocks.identity,
      changePassword: routeMocks.changePassword,
      totpSetup: routeMocks.totpSetup,
      totpConfirm: routeMocks.totpConfirm,
      webauthnRegistrationOptions: routeMocks.webauthnRegistrationOptions,
      registerPasskey: routeMocks.registerPasskey,
      deleteCredential: routeMocks.deleteCredential,
    },
    sudo: {
      requireFreshSudo: routeMocks.requireFreshSudo,
      currentSudo: routeMocks.currentSudo,
      clearSudo: routeMocks.clearSudo,
    },
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
const newPassword = "correct horse battery staple";
const auth = { accessToken: "server-held-user-token", sudoToken };
/** Stands in for the session-bound HMAC: deterministic, 43 base64url characters, never the id itself. */
const referenceOf = (credentialId: string) => createHash("sha256").update(`${activeSession.id}\0${credentialId}`).digest("base64url");

function problem(code: keyof typeof problemsFixture, status?: number) {
  const body = { ...problemsFixture[code], ...(status ? { status } : {}) };
  const mapped = parseSkyAccountProblem(body, body.status, null);
  if (!mapped) throw new Error(`fixture ${code} did not parse`);
  return mapped;
}

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
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
    method: options.method ?? (body === undefined && options.method === undefined ? "POST" : options.method ?? "POST"),
    headers,
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

function deletion(reference: string, options: RequestOptions = {}) {
  return deleteCredential(request(`/api/account/security/credentials/${reference}`, undefined, { ...options, method: "DELETE" }), {
    params: Promise.resolve({ reference }),
  });
}

async function textOf(response: Response) {
  return `${response.status} ${[...response.headers.entries()].join(";")} ${await response.text()}`;
}

const totpReference = referenceOf(identityFixture.credentials.totp[0]!.id);
const passkeyReference = referenceOf(identityFixture.credentials.passkeys[0]!.id);

describe("security BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const active = { status: "active", value: { session: activeSession, rotated: false } };
    routeMocks.authenticate.mockResolvedValue(active);
    routeMocks.authenticateMutation.mockResolvedValue(active);
    routeMocks.csrfToken.mockReturnValue("session-bound-csrf");
    routeMocks.credentialReference.mockImplementation((sessionId: string, credentialId: string) => {
      expect(sessionId).toBe(activeSession.id);
      return referenceOf(credentialId);
    });
    routeMocks.revokeSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.identity.mockResolvedValue(identityFixture);
    routeMocks.changePassword.mockResolvedValue(undefined);
    routeMocks.totpSetup.mockResolvedValue({
      ...totpSetupFixture,
      expiresAt: new Date(totpSetupFixture.expiresAt),
    });
    routeMocks.totpConfirm.mockResolvedValue(totpCredentialFixture);
    routeMocks.webauthnRegistrationOptions.mockResolvedValue(registrationOptionsFixture);
    routeMocks.registerPasskey.mockResolvedValue(passkeyCredentialFixture);
    routeMocks.deleteCredential.mockResolvedValue(undefined);
    routeMocks.requireFreshSudo.mockResolvedValue(proof);
    routeMocks.currentSudo.mockResolvedValue(null);
    routeMocks.clearSudo.mockResolvedValue(undefined);
    routeMocks.consumeKey.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 900 });
  });

  describe("GET /api/account/security", () => {
    it("lists the inventory with opaque references, the sudo state and the CSRF token, without PII or ids", async () => {
      routeMocks.currentSudo.mockResolvedValue({ method: "passkey", expiresAt: new Date("2026-09-21T13:15:18Z") });
      const response = await security(request("/api/account/security", undefined, { method: "GET", origin: null, csrf: null }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        password: true,
        totp: [{ reference: totpReference, label: "Telefon", createdAt: "2026-09-21T13:10:41.130Z" }],
        passkeys: [
          { reference: passkeyReference, label: "MacBook", createdAt: "2026-09-01T08:00:00.000Z" },
          { reference: referenceOf(identityFixture.credentials.passkeys[1]!.id), label: null, createdAt: null, legacy: true },
        ],
        sudo: {
          methods: ["password", "passkey", "totp"],
          fallback: null,
          active: { method: "passkey", expiresAt: "2026-09-21T13:15:18.000Z" },
        },
        csrfToken: "session-bound-csrf",
      });
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/Lovelace|ada@|account-fixture|2f0c5b4a|server-held|11111111-1111/);
      expect(routeMocks.identity).toHaveBeenCalledWith({ accessToken: "server-held-user-token" });
    });

    it("copies passkey transports and offers the Microsoft fallback when no method exists", async () => {
      routeMocks.identity.mockResolvedValue({
        ...identityFixture,
        credentials: {
          password: false,
          totp: [],
          passkeys: [{ ...identityFixture.credentials.passkeys[0], transports: ["internal", "hybrid"] }],
        },
      });
      const withPasskey = await (await security(request("/api/account/security", undefined, { method: "GET", origin: null, csrf: null }))).json();
      expect(withPasskey.passkeys[0]).toMatchObject({ transports: ["internal", "hybrid"] });
      expect(withPasskey.sudo).toEqual({ methods: ["passkey"], fallback: null, active: null });

      routeMocks.identity.mockResolvedValue({ ...identityFixture, credentials: { password: false, totp: [], passkeys: [] } });
      const none = await (await security(request("/api/account/security", undefined, { method: "GET", origin: null, csrf: null }))).json();
      expect(none.sudo).toEqual({ methods: [], fallback: "microsoft", active: null });
    });

    it.each([
      ["missing", 401, false],
      ["blocked", 401, true],
      ["unavailable", 503, false],
    ] as const)("answers the %s session outcome with %d", async (status, expected, clears) => {
      routeMocks.authenticate.mockResolvedValue({ status });
      const response = await security(new NextRequest(`${origin}/api/account/security`));
      expect(response.status).toBe(expected);
      expect(response.cookies.get(SESSION_COOKIE)?.value === "").toBe(clears);
      expect(routeMocks.identity).not.toHaveBeenCalled();
    });

    it("ends the local session when the bearer can no longer be refreshed and maps outages", async () => {
      routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
      const ended = await security(request("/api/account/security", undefined, { method: "GET", origin: null, csrf: null }));
      expect(ended.status).toBe(401);
      expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);

      routeMocks.accessToken.mockResolvedValue("server-held-user-token");
      routeMocks.identity.mockRejectedValue(new SkyAccountUnavailableError());
      const outage = await security(request("/api/account/security", undefined, { method: "GET", origin: null, csrf: null }));
      expect(outage.status).toBe(503);
      expect(outage.headers.get("retry-after")).toBe("3");
      await expect(outage.json()).resolves.toMatchObject({ error: "unavailable" });

      routeMocks.identity.mockRejectedValue(new SkyAccountContractError());
      const drift = await security(request("/api/account/security", undefined, { method: "GET", origin: null, csrf: null }));
      expect(drift.status).toBe(502);
      await expect(drift.json()).resolves.toMatchObject({ error: "upstream_error" });
    });
  });

  describe("sudo gate", () => {
    it("answers 428 sudo_required with the methods before reading the body or calling the SPI", async () => {
      routeMocks.requireFreshSudo.mockRejectedValue(new SudoRequiredError("expired", null));
      const response = await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true }));
      expect(response.status).toBe(428);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: "sudo_required",
        reason: "expired",
        methods: ["password", "passkey", "totp"],
        fallback: null,
      });
      expect(routeMocks.changePassword).not.toHaveBeenCalled();
      expect(routeMocks.consumeKey).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "security_action",
        outcome: "failure",
        reason: "sudo_required",
        securityAction: "password",
      }));
    });

    it("refuses a Microsoft re-authentication proof with 428 spi_token_required on every SPI route", async () => {
      routeMocks.requireFreshSudo.mockResolvedValue({ method: "reauth", sudoToken: null, expiresAt: proof.expiresAt });
      routeMocks.identity.mockResolvedValue({ ...identityFixture, credentials: { password: false, totp: [], passkeys: [] } });
      const answers = [
        await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true })),
        await totpSetup(request("/api/account/security/totp/setup")),
        await totpConfirm(request("/api/account/security/totp/confirm", { setupHandle: totpSetupFixture.setupHandle, code: "123456", label: "Telefon" })),
        await passkeyOptions(request("/api/account/security/passkeys/options")),
        await passkeyRegister(request("/api/account/security/passkeys/register", { attestation: attestationJson, label: "iPhone" })),
        await deletion(totpReference),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(428);
        await expect(answer.json()).resolves.toEqual({
          error: "sudo_required",
          reason: "spi_token_required",
          methods: [],
          fallback: "microsoft",
        });
      }
      for (const spi of [
        routeMocks.changePassword, routeMocks.totpSetup, routeMocks.totpConfirm,
        routeMocks.webauthnRegistrationOptions, routeMocks.registerPasskey, routeMocks.deleteCredential,
      ]) expect(spi).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "spi_token_required", securityAction: "credential_delete" }));
    });

    it("discards a proof the SPI rejects and re-issues the 428 challenge", async () => {
      routeMocks.changePassword.mockRejectedValue(problem("sudo_expired"));
      const response = await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true }));
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
  });

  describe("POST password", () => {
    it("forwards the new password with the sudo token and answers 204 without a body", async () => {
      const response = await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: false }));
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(routeMocks.changePassword).toHaveBeenCalledWith(auth, { newPassword, logoutOtherSessions: false });
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("security_mutation", activeSession.id);
      expect(routeMocks.requireFreshSudo).toHaveBeenCalledWith(activeSession.id, { requestId: "request-id" });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "security_action",
        outcome: "success",
        securityAction: "password",
      }));
    });

    it("renders the realm policy rejection with policy and params from the SPI", async () => {
      routeMocks.changePassword.mockRejectedValue(problem("password_policy"));
      const response = await changePassword(request("/api/account/security/password", { newPassword: "short", logoutOtherSessions: true }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "password_policy",
        detail: "Geçersiz Şifre: En az 12 karakter uzunluğunda olmalı.",
        policy: "invalidPasswordMinLengthMessage",
        params: [12],
      });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "policy_rejected" }));
    });

    it("rejects malformed bodies before contacting the SPI", async () => {
      const cases: Array<[Promise<Response>, number]> = [
        [changePassword(request("/api/account/security/password", { newPassword: "", logoutOtherSessions: true })), 400],
        [changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: "yes" })), 400],
        [changePassword(request("/api/account/security/password", { newPassword })), 400],
        [changePassword(request("/api/account/security/password", { newPassword: "x".repeat(1_025), logoutOtherSessions: true })), 400],
        [changePassword(request("/api/account/security/password", { newPassword: "x".repeat(5_000), logoutOtherSessions: true })), 413],
        [changePassword(request("/api/account/security/password", `{"newPassword":"${newPassword}`)), 400],
        [changePassword(request("/api/account/security/password", "[]")), 400],
        [changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true }, { contentType: "text/plain" })), 400],
      ];
      for (const [answer, status] of cases) {
        const response = await answer;
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
      }
      expect(routeMocks.changePassword).not.toHaveBeenCalled();
    });

    it("never echoes the password, secrets, tokens or credential ids in any answer or log", async () => {
      routeMocks.changePassword.mockRejectedValueOnce(problem("password_rejected"));
      const answers = [
        await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true })),
        await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true }, { csrf: null })),
        await changePassword(request("/api/account/security/password", `{"newPassword":"${newPassword}`)),
        await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true })),
        await totpSetup(request("/api/account/security/totp/setup")),
        await deletion(totpReference),
      ];
      for (const answer of answers) {
        const text = await textOf(answer);
        expect(text).not.toContain(newPassword);
        expect(text).not.toContain(sudoToken);
        expect(text).not.toContain("server-held-user-token");
        expect(text).not.toContain("2f0c5b4a");
      }
      for (const call of vi.mocked(logAuthEvent).mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(newPassword);
        expect(serialized).not.toContain(sudoToken.slice(0, 30));
        expect(serialized).not.toContain(totpSetupFixture.secret);
        expect(serialized).not.toContain("2f0c5b4a");
        expect(serialized).not.toContain("Telefon");
      }
    });
  });

  describe("TOTP", () => {
    it("relays the setup (secret shown once) and confirms with the label, answering the new row", async () => {
      const setup = await totpSetup(request("/api/account/security/totp/setup"));
      expect(setup.status).toBe(200);
      expect(setup.headers.get("cache-control")).toBe("no-store");
      await expect(setup.json()).resolves.toEqual({
        setupHandle: totpSetupFixture.setupHandle,
        secret: totpSetupFixture.secret,
        otpauthUri: totpSetupFixture.otpauthUri,
        expiresAt: "2026-09-21T13:20:18.000Z",
        policy: { type: "totp", algorithm: "SHA1", digits: 6, period: 30 },
      });
      expect(routeMocks.totpSetup).toHaveBeenCalledWith(auth);
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("security_mutation", activeSession.id);

      const confirmed = await totpConfirm(request("/api/account/security/totp/confirm", {
        setupHandle: totpSetupFixture.setupHandle,
        code: "123 456",
        label: "  Telefon  ",
      }));
      expect(confirmed.status).toBe(201);
      await expect(confirmed.json()).resolves.toEqual({
        credential: { reference: referenceOf(totpCredentialFixture.id), label: "Telefon", createdAt: "2026-09-21T13:10:41.130Z" },
      });
      expect(routeMocks.totpConfirm).toHaveBeenCalledWith(auth, { setupHandle: totpSetupFixture.setupHandle, code: "123456", label: "Telefon" });
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("totp_confirm", activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", securityAction: "totp_confirm" }));
    });

    it.each([
      ["invalid_totp_code", 400, "invalid_code", "invalid_code"],
      ["totp_setup_expired", 400, "setup_expired", "setup_expired"],
      ["duplicate_label", 409, "duplicate_label", "duplicate_label"],
      ["rate_limited", 429, "rate_limited", "rate_limited"],
      ["invalid_request", 400, "invalid_request", "contract_blocked"],
      ["internal_error", 502, "upstream_error", "contract_blocked"],
      ["unmanaged_attributes_enabled", 503, "unavailable", "provider_unavailable"],
    ] as const)("maps the %s confirmation problem to %d %s", async (code, status, error, reason) => {
      routeMocks.totpConfirm.mockRejectedValue(problem(code));
      const response = await totpConfirm(request("/api/account/security/totp/confirm", {
        setupHandle: totpSetupFixture.setupHandle,
        code: "123456",
        label: "Telefon",
      }));
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error).toBe(error);
      if (status !== 502) expect(body.detail).toBe(problemsFixture[code].detail);
      if (code === "rate_limited") {
        expect(response.headers.get("retry-after")).toBe("540");
        expect(body.retryAfter).toBe(540);
      }
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason, securityAction: "totp_confirm" }));
    });

    it("rejects malformed confirmation bodies before contacting the SPI", async () => {
      const bodies = [
        { setupHandle: "handle with spaces", code: "123456", label: "Telefon" },
        { setupHandle: totpSetupFixture.setupHandle, code: "12ab", label: "Telefon" },
        { setupHandle: totpSetupFixture.setupHandle, code: "123456", label: "" },
        { setupHandle: totpSetupFixture.setupHandle, code: "123456", label: "x".repeat(65) },
        // Only format characters and NBSPs: empty once normalised like the SPI does.
        { setupHandle: totpSetupFixture.setupHandle, code: "123456", label: "\u200B\u200D\uFEFF" },
        { setupHandle: totpSetupFixture.setupHandle, code: "123456", label: "\u00A0\u00A0\u3000" },
        { setupHandle: totpSetupFixture.setupHandle, code: "123456", label: 42 },
        { code: "123456", label: "Telefon" },
      ];
      for (const body of bodies) {
        expect((await totpConfirm(request("/api/account/security/totp/confirm", body))).status).toBe(400);
      }
      expect(routeMocks.totpConfirm).not.toHaveBeenCalled();
    });

    it("normalises labels like the SPI (format characters dropped, spaces collapsed) before the length check", async () => {
      const confirmed = await totpConfirm(request("/api/account/security/totp/confirm", {
        setupHandle: totpSetupFixture.setupHandle,
        code: "123456",
        label: "\uFEFF Tele\u200Bfon\u00A0\u00A015\u2060 ",
      }));
      expect(confirmed.status).toBe(201);
      expect(routeMocks.totpConfirm).toHaveBeenCalledWith(auth, expect.objectContaining({ label: "Telefon 15" }));

      // 64 characters plus zero-width padding is still 64 after normalisation; 65 real characters is not.
      const padded = await totpConfirm(request("/api/account/security/totp/confirm", {
        setupHandle: totpSetupFixture.setupHandle,
        code: "123456",
        label: `\u200B${"x".repeat(64)}\u200B`,
      }));
      expect(padded.status).toBe(201);
      expect(routeMocks.totpConfirm).toHaveBeenLastCalledWith(auth, expect.objectContaining({ label: "x".repeat(64) }));
      const overlong = await totpConfirm(request("/api/account/security/totp/confirm", {
        setupHandle: totpSetupFixture.setupHandle,
        code: "123456",
        label: `${"x".repeat(60)}\u00A0\u00A0${"y".repeat(4)}`,
      }));
      expect(overlong.status).toBe(400);
      expect(routeMocks.totpConfirm).toHaveBeenCalledTimes(2);

      const registered = await passkeyRegister(request("/api/account/security/passkeys/register", {
        attestation: attestationJson,
        label: "iPhone\u2003\u200D\u2003Pro",
      }));
      expect(registered.status).toBe(201);
      expect(routeMocks.registerPasskey).toHaveBeenCalledWith(auth, expect.objectContaining({ label: "iPhone Pro" }));
    });
  });

  describe("passkeys", () => {
    it("relays creation options under sudo and registers only the documented attestation members with the label", async () => {
      const options = await passkeyOptions(request("/api/account/security/passkeys/options"));
      expect(options.status).toBe(200);
      await expect(options.json()).resolves.toEqual(registrationOptionsFixture);
      expect(routeMocks.webauthnRegistrationOptions).toHaveBeenCalledWith(auth);

      const registered = await passkeyRegister(request("/api/account/security/passkeys/register", {
        attestation: { ...attestationJson, clientExtensionResults: { injected: "page-data" } },
        label: "iPhone",
      }));
      expect(registered.status).toBe(201);
      await expect(registered.json()).resolves.toEqual({
        credential: {
          reference: referenceOf(passkeyCredentialFixture.id),
          label: "iPhone",
          createdAt: "2026-09-21T13:12:00.000Z",
          transports: ["internal", "hybrid"],
        },
      });
      expect(routeMocks.registerPasskey).toHaveBeenCalledWith(auth, {
        attestation: {
          id: attestationJson.id,
          rawId: attestationJson.rawId,
          type: "public-key",
          response: attestationJson.response,
          authenticatorAttachment: "platform",
        },
        label: "iPhone",
      });
      expect(JSON.stringify(routeMocks.registerPasskey.mock.calls[0])).not.toContain("injected");
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", securityAction: "passkey_register" }));
    });

    it.each([
      ["passkey_already_registered", 409, "passkey_already_registered", "already_registered"],
      ["duplicate_label", 409, "duplicate_label", "duplicate_label"],
      ["webauthn_invalid", 400, "webauthn_invalid", "webauthn_rejected"],
      ["webauthn_origin_not_allowed", 400, "webauthn_origin_not_allowed", "webauthn_rejected"],
      ["webauthn_challenge_expired", 400, "challenge_expired", "webauthn_rejected"],
      ["webauthn_not_configured", 503, "unavailable", "provider_unavailable"],
    ] as const)("maps the %s registration problem to %d %s", async (code, status, error, reason) => {
      routeMocks.registerPasskey.mockRejectedValue(problem(code, code.startsWith("webauthn_") && code !== "webauthn_not_configured" ? 400 : undefined));
      const response = await passkeyRegister(request("/api/account/security/passkeys/register", { attestation: attestationJson, label: "iPhone" }));
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error, detail: problemsFixture[code].detail });
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason, securityAction: "passkey_register" }));
    });

    it("rejects malformed attestations and labels before contacting the SPI, and bounds the body at 64 KB", async () => {
      const cases: Array<[unknown, number]> = [
        [{ attestation: { ...attestationJson, rawId: "other" }, label: "iPhone" }, 400],
        [{ attestation: { ...attestationJson, response: { clientDataJSON: attestationJson.response.clientDataJSON } }, label: "iPhone" }, 400],
        [{ attestation: attestationJson, label: "" }, 400],
        [{ attestation: attestationJson }, 400],
        [{ label: "iPhone" }, 400],
        [{ attestation: { ...attestationJson, response: { ...attestationJson.response, attestationObject: "A".repeat(70_000) } }, label: "iPhone" }, 413],
      ];
      for (const [body, status] of cases) {
        expect((await passkeyRegister(request("/api/account/security/passkeys/register", body))).status).toBe(status);
      }
      expect(routeMocks.registerPasskey).not.toHaveBeenCalled();
    });
  });

  describe("DELETE credentials/{reference}", () => {
    it("resolves the session-bound reference against a fresh identity read and deletes exactly that credential", async () => {
      const response = await deletion(passkeyReference);
      expect(response.status).toBe(204);
      expect(routeMocks.identity).toHaveBeenCalledWith({ accessToken: "server-held-user-token" });
      expect(routeMocks.deleteCredential).toHaveBeenCalledWith(auth, identityFixture.credentials.passkeys[0]!.id);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", securityAction: "credential_delete" }));
    });

    it("answers 404 for unknown, foreign or malformed references without calling the SPI", async () => {
      for (const reference of ["x".repeat(43), referenceOf("someone-elses-credential"), "../identity", "short"]) {
        const response = await deletion(reference);
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: "credential_not_found" });
      }
      expect(routeMocks.deleteCredential).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "credential_not_found" }));
    });

    it("relays the SPI's credential_not_found when the credential vanished meanwhile", async () => {
      routeMocks.deleteCredential.mockRejectedValue(problem("credential_not_found"));
      const response = await deletion(totpReference);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "credential_not_found", detail: "Kimlik bilgisi bulunamadı." });
    });
  });

  describe("request guards", () => {
    it("requires the exact origin and the session CSRF proof before any work", async () => {
      const body = { newPassword, logoutOtherSessions: true };
      for (const options of [{ origin: "https://attacker.invalid" }, { origin: null }, { origin: "https://my.yildizskylab.com/" }]) {
        expect((await changePassword(request("/api/account/security/password", body, options))).status).toBe(403);
      }
      expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();

      routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
      expect((await changePassword(request("/api/account/security/password", body, { csrf: "wrong" }))).status).toBe(403);
      routeMocks.authenticateMutation.mockResolvedValue({ status: "missing" });
      expect((await totpSetup(request("/api/account/security/totp/setup"))).status).toBe(401);
      routeMocks.authenticateMutation.mockResolvedValue({ status: "blocked" });
      const blocked = await passkeyOptions(request("/api/account/security/passkeys/options"));
      expect(blocked.status).toBe(401);
      expect(blocked.cookies.get(SESSION_COOKIE)?.value).toBe("");
      routeMocks.authenticateMutation.mockResolvedValue({ status: "unavailable" });
      expect((await deletion(totpReference)).status).toBe(503);
      expect(routeMocks.requireFreshSudo).not.toHaveBeenCalled();
      expect(routeMocks.consumeKey).not.toHaveBeenCalled();
    });

    it("stops at the local per-session budget after the sudo gate and before the SPI", async () => {
      routeMocks.consumeKey.mockResolvedValue({ allowed: false, count: 31, retryAfterSeconds: 321 });
      const response = await totpSetup(request("/api/account/security/totp/setup"));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("321");
      await expect(response.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 321 });
      expect(routeMocks.requireFreshSudo).toHaveBeenCalled();
      expect(routeMocks.totpSetup).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "rate_limited", securityAction: "totp_setup" }));
    });

    it("ends the local session when Keycloak or the SPI reject the bearer, and keeps a rotated handle otherwise", async () => {
      routeMocks.changePassword.mockRejectedValue(problem("unauthorized"));
      const rejected = await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true }));
      expect(rejected.status).toBe(401);
      expect(rejected.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);

      routeMocks.changePassword.mockResolvedValue(undefined);
      routeMocks.authenticateMutation.mockResolvedValue({
        status: "active",
        value: { session: activeSession, rotated: true, rotatedHandle: "n".repeat(43) },
      });
      const rotated = await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true }));
      expect(rotated.status).toBe(204);
      expect(rotated.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
      routeMocks.requireFreshSudo.mockRejectedValue(new SudoRequiredError("missing", null));
      const challenged = await changePassword(request("/api/account/security/password", { newPassword, logoutOtherSessions: true }));
      expect(challenged.status).toBe(428);
      expect(challenged.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
    });

    it("maps an unreachable SPI and contract drift without echoing anything", async () => {
      routeMocks.totpSetup.mockRejectedValue(new SkyAccountUnavailableError());
      const outage = await totpSetup(request("/api/account/security/totp/setup"));
      expect(outage.status).toBe(503);
      expect(outage.headers.get("retry-after")).toBe("3");
      routeMocks.totpSetup.mockRejectedValue(new SkyAccountContractError());
      const drift = await totpSetup(request("/api/account/security/totp/setup"));
      expect(drift.status).toBe(502);
      await expect(drift.json()).resolves.toMatchObject({ error: "upstream_error" });
      routeMocks.totpSetup.mockRejectedValue(new Error("boom secret-detail"));
      const unexpected = await totpSetup(request("/api/account/security/totp/setup"));
      expect(unexpected.status).toBe(500);
      expect(await unexpected.text()).not.toContain("secret-detail");
    });
  });
});
