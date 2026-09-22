// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import problemsFixture from "../../../tests/fixtures/sky-account-v1-problems.json";
import sudoGrantFixture from "../../../tests/fixtures/sky-account-v1-sudo-grant.json";
import assertionJson from "../../../tests/fixtures/sky-account-v1-webauthn-assertion.json";
import assertionOptionsFixture from "../../../tests/fixtures/sky-account-v1-webauthn-assertion-options.json";
import { GET as methods } from "@/app/api/account/sudo/methods/route";
import { POST as password } from "@/app/api/account/sudo/password/route";
import { POST as reauthenticate } from "@/app/api/account/sudo/reauthenticate/route";
import { POST as totp } from "@/app/api/account/sudo/totp/route";
import { POST as webauthnOptions } from "@/app/api/account/sudo/webauthn/options/route";
import { POST as webauthnVerify } from "@/app/api/account/sudo/webauthn/verify/route";
import { OIDC_TRANSACTION_COOKIE, SESSION_COOKIE } from "@/server/auth/http";
import { logAuthEvent } from "@/server/auth/logging";
import { SudoSessionInactiveError } from "@/server/auth/sudo";
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
  sudoPassword: vi.fn(),
  sudoTotp: vi.fn(),
  sudoWebauthnOptions: vi.fn(),
  sudoWebauthnVerify: vi.fn(),
  storeSudo: vi.fn(),
  currentSudo: vi.fn(),
  consumeKey: vi.fn(),
  beginSudoReauthentication: vi.fn(),
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
      revokeSession: routeMocks.revokeSession,
    },
    account: { accessToken: routeMocks.accessToken },
    skyAccount: {
      identity: routeMocks.identity,
      sudoPassword: routeMocks.sudoPassword,
      sudoTotp: routeMocks.sudoTotp,
      sudoWebauthnOptions: routeMocks.sudoWebauthnOptions,
      sudoWebauthnVerify: routeMocks.sudoWebauthnVerify,
    },
    sudo: {
      storeSudo: routeMocks.storeSudo,
      currentSudo: routeMocks.currentSudo,
    },
    anonymousRateLimit: { consumeKey: routeMocks.consumeKey },
    oidc: { beginSudoReauthentication: routeMocks.beginSudoReauthentication },
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
const secretPassword = "hunter2-correct-horse";
const grant = { sudoToken: sudoGrantFixture.sudoToken, expiresAt: new Date("2026-09-21T13:15:18Z") };

function problem(code: keyof typeof problemsFixture, retryAfterHeader: string | null = null) {
  const body = problemsFixture[code];
  const mapped = parseSkyAccountProblem(body, body.status, retryAfterHeader);
  if (!mapped) throw new Error(`fixture ${code} did not parse`);
  return mapped;
}

function jsonRequest(
  path: string,
  body: unknown,
  options: { origin?: string | null; csrf?: string | null; contentType?: string; cookie?: boolean } = {},
) {
  const headers = new Headers();
  if (options.cookie !== false) headers.set("cookie", `${SESSION_COOKIE}=${"h".repeat(43)}`);
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (options.csrf !== null) headers.set("x-csrf-token", options.csrf ?? "session-bound-csrf");
  headers.set("content-type", options.contentType ?? "application/json");
  return new NextRequest(`${origin}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function formRequest(body: string, options: { html?: boolean; origin?: string } = {}) {
  const headers = new Headers({
    cookie: `${SESSION_COOKIE}=${"h".repeat(43)}`,
    origin: options.origin ?? origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (options.html) {
    headers.set("sec-fetch-mode", "navigate");
    headers.set("sec-fetch-dest", "document");
    headers.set("accept", "text/html,application/xhtml+xml");
  }
  return new NextRequest(`${origin}/api/account/sudo/reauthenticate`, { method: "POST", headers, body });
}

async function textOf(response: Response) {
  return `${response.status} ${[...response.headers.entries()].join(";")} ${await response.text()}`;
}

describe("sudo BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const active = { status: "active", value: { session: activeSession, rotated: false } };
    routeMocks.authenticate.mockResolvedValue(active);
    routeMocks.authenticateMutation.mockResolvedValue(active);
    routeMocks.csrfToken.mockReturnValue("session-bound-csrf");
    routeMocks.revokeSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.identity.mockResolvedValue(identityFixture);
    routeMocks.sudoPassword.mockResolvedValue(grant);
    routeMocks.sudoTotp.mockResolvedValue(grant);
    routeMocks.sudoWebauthnOptions.mockResolvedValue(assertionOptionsFixture);
    routeMocks.sudoWebauthnVerify.mockResolvedValue(grant);
    routeMocks.storeSudo.mockResolvedValue(undefined);
    routeMocks.currentSudo.mockResolvedValue(null);
    routeMocks.consumeKey.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 900 });
    routeMocks.beginSudoReauthentication.mockResolvedValue({
      authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3Asudo"),
      browserBinding: "b".repeat(43),
    });
  });

  describe("GET methods", () => {
    it("lists the available methods, the active proof and the CSRF token without PII or tokens", async () => {
      routeMocks.currentSudo.mockResolvedValue({ method: "totp", expiresAt: new Date("2026-09-21T13:15:18Z") });
      const response = await methods(new NextRequest(`${origin}/api/account/sudo/methods`, {
        headers: { cookie: `${SESSION_COOKIE}=${"h".repeat(43)}` },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        methods: ["password", "passkey", "totp"],
        fallback: null,
        active: { method: "totp", expiresAt: "2026-09-21T13:15:18.000Z" },
        csrfToken: "session-bound-csrf",
      });
      expect(JSON.stringify(body)).not.toMatch(/Lovelace|ada@|MacBook|Telefon|2f0c5b4a|server-held/);
      expect(routeMocks.identity).toHaveBeenCalledWith({ accessToken: "server-held-user-token" });
    });

    it("offers the Microsoft fallback when the person has no in-product method", async () => {
      routeMocks.identity.mockResolvedValue({
        ...identityFixture,
        credentials: { password: false, totp: [], passkeys: [] },
      });
      const response = await methods(new NextRequest(`${origin}/api/account/sudo/methods`, {
        headers: { cookie: `${SESSION_COOKIE}=${"h".repeat(43)}` },
      }));
      await expect(response.json()).resolves.toMatchObject({ methods: [], fallback: "microsoft", active: null });
    });

    it.each([
      ["missing", 401, false],
      ["blocked", 401, true],
      ["unavailable", 503, false],
    ] as const)("answers the %s session outcome with %d", async (status, expected, clears) => {
      routeMocks.authenticate.mockResolvedValue({ status });
      const response = await methods(new NextRequest(`${origin}/api/account/sudo/methods`));
      expect(response.status).toBe(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.cookies.get(SESSION_COOKIE)?.value === "").toBe(clears);
      expect(routeMocks.identity).not.toHaveBeenCalled();
    });

    it("ends the local session when the bearer can no longer be refreshed", async () => {
      routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
      const response = await methods(new NextRequest(`${origin}/api/account/sudo/methods`, {
        headers: { cookie: `${SESSION_COOKIE}=${"h".repeat(43)}` },
      }));
      expect(response.status).toBe(401);
      expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);
    });

    it("maps an unavailable identity service to a retryable 503", async () => {
      routeMocks.identity.mockRejectedValue(new SkyAccountUnavailableError());
      const response = await methods(new NextRequest(`${origin}/api/account/sudo/methods`, {
        headers: { cookie: `${SESSION_COOKIE}=${"h".repeat(43)}` },
      }));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("3");
      await expect(response.json()).resolves.toMatchObject({ error: "unavailable" });
    });
  });

  describe("POST password / totp / webauthn", () => {
    it("proves with the password, stores the grant and answers only the deadline and method", async () => {
      const response = await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ method: "password", expiresAt: "2026-09-21T13:15:18.000Z" });
      expect(routeMocks.sudoPassword).toHaveBeenCalledWith(
        { accessToken: "server-held-user-token" },
        { password: secretPassword },
      );
      expect(routeMocks.storeSudo).toHaveBeenCalledWith(
        activeSession.id,
        sudoGrantFixture.sudoToken,
        new Date("2026-09-21T13:15:18Z"),
        "password",
      );
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("sudo", activeSession.id);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "sudo_attempt",
        outcome: "success",
        sudoMethod: "password",
      }));
    });

    it("proves with a verification code, tolerating grouping spaces", async () => {
      const response = await totp(jsonRequest("/api/account/sudo/totp", { code: "123 456" }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ method: "totp", expiresAt: "2026-09-21T13:15:18.000Z" });
      expect(routeMocks.sudoTotp).toHaveBeenCalledWith({ accessToken: "server-held-user-token" }, { code: "123456" });
      expect(routeMocks.storeSudo).toHaveBeenCalledWith(activeSession.id, sudoGrantFixture.sudoToken, expect.any(Date), "totp");
    });

    it("relays passkey options and forwards only the documented assertion members", async () => {
      const optionsResponse = await webauthnOptions(jsonRequest("/api/account/sudo/webauthn/options", ""));
      expect(optionsResponse.status).toBe(200);
      await expect(optionsResponse.json()).resolves.toEqual(assertionOptionsFixture);
      expect(routeMocks.consumeKey).toHaveBeenCalledWith("sudo_options", activeSession.id);

      const response = await webauthnVerify(jsonRequest("/api/account/sudo/webauthn/verify", {
        assertion: { ...assertionJson, authenticatorAttachment: "platform", clientExtensionResults: { injected: true } },
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ method: "passkey", expiresAt: "2026-09-21T13:15:18.000Z" });
      expect(routeMocks.sudoWebauthnVerify).toHaveBeenCalledWith(
        { accessToken: "server-held-user-token" },
        {
          id: assertionJson.id,
          rawId: assertionJson.rawId,
          type: "public-key",
          response: assertionJson.response,
        },
      );
      expect(routeMocks.storeSudo).toHaveBeenCalledWith(activeSession.id, sudoGrantFixture.sudoToken, expect.any(Date), "passkey");
    });

    it("never echoes the password, code, assertion or sudo token in any answer", async () => {
      routeMocks.sudoPassword.mockRejectedValue(problem("invalid_credentials"));
      routeMocks.sudoTotp.mockRejectedValue(new SkyAccountContractError());
      routeMocks.sudoWebauthnVerify.mockRejectedValue(problem("webauthn_invalid"));
      const answers = [
        await password(jsonRequest("/api/account/sudo/password", { password: secretPassword })),
        await totp(jsonRequest("/api/account/sudo/totp", { code: "987654" })),
        await webauthnVerify(jsonRequest("/api/account/sudo/webauthn/verify", { assertion: assertionJson })),
        await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }, { csrf: null })),
        await password(jsonRequest("/api/account/sudo/password", `{"password":"${secretPassword}`)),
      ];
      routeMocks.sudoPassword.mockResolvedValue(grant);
      answers.push(await password(jsonRequest("/api/account/sudo/password", { password: secretPassword })));
      for (const answer of answers) {
        const text = await textOf(answer);
        expect(text).not.toContain(secretPassword);
        expect(text).not.toContain("987654");
        expect(text).not.toContain(assertionJson.response.signature);
        expect(text).not.toContain(sudoGrantFixture.sudoToken);
        expect(text).not.toContain("server-held-user-token");
      }
      for (const call of vi.mocked(logAuthEvent).mock.calls) {
        expect(JSON.stringify(call)).not.toMatch(new RegExp(`${secretPassword}|987654|${sudoGrantFixture.sudoToken.slice(0, 40)}`));
      }
    });

    it.each([
      ["invalid_credentials", 401, "invalid_credentials"],
      ["user_temporarily_locked", 423, "locked"],
      ["user_disabled", 403, "disabled"],
      ["password_not_configured", 400, "method_unavailable"],
      ["totp_not_configured", 400, "method_unavailable"],
      ["passkey_not_registered", 400, "method_unavailable"],
      ["webauthn_challenge_expired", 400, "challenge_expired"],
      ["webauthn_invalid", 401, "invalid_credentials"],
      ["webauthn_origin_not_allowed", 401, "invalid_credentials"],
      ["invalid_request", 400, "invalid_request"],
      ["webauthn_not_configured", 503, "unavailable"],
      ["unmanaged_attributes_enabled", 503, "unavailable"],
      ["internal_error", 502, "upstream_error"],
      ["sudo_required", 502, "upstream_error"],
    ] as const)("maps the %s problem to %d %s with the Turkish detail", async (code, status, error) => {
      routeMocks.sudoPassword.mockRejectedValue(problem(code));
      const response = await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.error).toBe(error);
      expect(typeof body.detail).toBe("string");
      if (status !== 502) expect(body.detail).toBe(problemsFixture[code].detail);
      expect(routeMocks.storeSudo).not.toHaveBeenCalled();
      expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    });

    it("relays the upstream rate limit with its Retry-After", async () => {
      routeMocks.sudoTotp.mockRejectedValue(problem("rate_limited"));
      const response = await totp(jsonRequest("/api/account/sudo/totp", { code: "123456" }));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("540");
      await expect(response.json()).resolves.toEqual({
        error: "rate_limited",
        detail: problemsFixture.rate_limited.detail,
        retryAfter: 540,
      });
    });

    it("stops at the local per-session budget before contacting the extension", async () => {
      routeMocks.consumeKey.mockResolvedValue({ allowed: false, count: 11, retryAfterSeconds: 321 });
      const response = await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("321");
      await expect(response.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 321 });
      expect(routeMocks.accessToken).not.toHaveBeenCalled();
      expect(routeMocks.sudoPassword).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "rate_limited", sudoMethod: "password" }));
    });

    it("ends the local session when Keycloak or the extension reject the bearer", async () => {
      routeMocks.sudoPassword.mockRejectedValue(problem("unauthorized"));
      const rejected = await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }));
      expect(rejected.status).toBe(401);
      await expect(rejected.json()).resolves.toEqual({ error: "authentication_required" });
      expect(rejected.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);

      routeMocks.storeSudo.mockRejectedValue(new SudoSessionInactiveError());
      routeMocks.sudoPassword.mockResolvedValue(grant);
      const inactive = await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }));
      expect(inactive.status).toBe(401);
      expect(inactive.cookies.get(SESSION_COOKIE)?.value).toBe("");
    });

    it("requires the exact origin and the session CSRF proof before any work", async () => {
      const cases = [
        jsonRequest("/api/account/sudo/password", { password: secretPassword }, { origin: "https://attacker.invalid" }),
        jsonRequest("/api/account/sudo/password", { password: secretPassword }, { origin: null }),
        jsonRequest("/api/account/sudo/password", { password: secretPassword }, { origin: "https://my.yildizskylab.com/" }),
      ];
      for (const request of cases) {
        expect((await password(request)).status).toBe(403);
      }
      expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();

      routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
      expect((await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }, { csrf: "wrong" }))).status).toBe(403);
      routeMocks.authenticateMutation.mockResolvedValue({ status: "missing" });
      expect((await totp(jsonRequest("/api/account/sudo/totp", { code: "123456" }))).status).toBe(401);
      routeMocks.authenticateMutation.mockResolvedValue({ status: "blocked" });
      const blocked = await webauthnOptions(jsonRequest("/api/account/sudo/webauthn/options", ""));
      expect(blocked.status).toBe(401);
      expect(blocked.cookies.get(SESSION_COOKIE)?.value).toBe("");
      routeMocks.authenticateMutation.mockResolvedValue({ status: "unavailable" });
      expect((await webauthnVerify(jsonRequest("/api/account/sudo/webauthn/verify", { assertion: assertionJson }))).status).toBe(503);
      expect(routeMocks.consumeKey).not.toHaveBeenCalled();
      expect(routeMocks.sudoPassword).not.toHaveBeenCalled();
    });

    it("rejects malformed bodies without contacting the extension", async () => {
      const cases: Array<[Promise<Response>, number]> = [
        [password(jsonRequest("/api/account/sudo/password", { password: "" })), 400],
        [password(jsonRequest("/api/account/sudo/password", { password: 42 })), 400],
        [password(jsonRequest("/api/account/sudo/password", { password: "x".repeat(1_025) })), 400],
        [password(jsonRequest("/api/account/sudo/password", { password: "x".repeat(3_000) })), 413],
        [password(jsonRequest("/api/account/sudo/password", "password=x", { contentType: "application/x-www-form-urlencoded" })), 400],
        [password(jsonRequest("/api/account/sudo/password", [secretPassword])), 400],
        [totp(jsonRequest("/api/account/sudo/totp", { code: "12a456" })), 400],
        [totp(jsonRequest("/api/account/sudo/totp", { code: "123" })), 400],
        [totp(jsonRequest("/api/account/sudo/totp", { password: secretPassword })), 400],
        [webauthnVerify(jsonRequest("/api/account/sudo/webauthn/verify", { assertion: { ...assertionJson, rawId: "other" } })), 400],
        [webauthnVerify(jsonRequest("/api/account/sudo/webauthn/verify", { assertion: "string" })), 400],
        [webauthnVerify(jsonRequest("/api/account/sudo/webauthn/verify", { assertion: { ...assertionJson, response: { ...assertionJson.response, signature: "A".repeat(70_000) } } })), 413],
      ];
      for (const [pending, status] of cases) {
        const response = await pending;
        expect(response.status).toBe(status);
        await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
      }
      expect(routeMocks.sudoPassword).not.toHaveBeenCalled();
      expect(routeMocks.sudoTotp).not.toHaveBeenCalled();
      expect(routeMocks.sudoWebauthnVerify).not.toHaveBeenCalled();
      expect(routeMocks.storeSudo).not.toHaveBeenCalled();
    });

    it("rotates the opaque session handle on the answer when the store asks for it", async () => {
      routeMocks.authenticateMutation.mockResolvedValue({
        status: "active",
        value: { session: activeSession, rotated: true, rotatedHandle: "n".repeat(43) },
      });
      const response = await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }));
      expect(response.status).toBe(200);
      expect(response.cookies.get(SESSION_COOKIE)).toMatchObject({
        value: "n".repeat(43),
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      });
      expect(response.headers.get("set-cookie")).not.toContain("Domain=");

      routeMocks.sudoPassword.mockRejectedValue(problem("unauthorized"));
      const ended = await password(jsonRequest("/api/account/sudo/password", { password: secretPassword }));
      expect(ended.status).toBe(401);
      expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
    });

    it.each([
      ["invalid_credentials", 401],
      ["webauthn_invalid", 401],
      ["user_temporarily_locked", 423],
      ["rate_limited", 429],
    ] as const)("keeps the session usable after a rejected proof (%s): the rotated handle is set and the next attempt authenticates", async (code, status) => {
      const rotatedHandle = "n".repeat(43);
      routeMocks.authenticateMutation.mockResolvedValueOnce({
        status: "active",
        value: { session: activeSession, rotated: true, rotatedHandle },
      });
      routeMocks.sudoPassword.mockRejectedValueOnce(problem(code));
      const rejected = await password(jsonRequest("/api/account/sudo/password", { password: "wrong-password" }));
      expect(rejected.status).toBe(status);
      expect(rejected.cookies.get(SESSION_COOKIE)).toMatchObject({ value: rotatedHandle, httpOnly: true, secure: true });
      expect(routeMocks.revokeSession).not.toHaveBeenCalled();

      const retry = new NextRequest(`${origin}/api/account/sudo/password`, {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${rejected.cookies.get(SESSION_COOKIE)!.value}`,
          origin,
          "sec-fetch-site": "same-origin",
          "x-csrf-token": "session-bound-csrf",
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: secretPassword }),
      });
      const accepted = await password(retry);
      expect(routeMocks.authenticateMutation).toHaveBeenLastCalledWith(
        rotatedHandle,
        "session-bound-csrf",
        expect.objectContaining({ allowRotation: true }),
      );
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({ method: "password" });
    });
  });

  describe("POST reauthenticate (Microsoft fallback)", () => {
    const noMethods = { ...identityFixture, credentials: { password: false, totp: [], passkeys: [] } };

    beforeEach(() => {
      routeMocks.identity.mockResolvedValue(noMethods);
    });

    it("starts a forced re-authentication bound to the session and returns to the requested page", async () => {
      const response = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity", { html: true }));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3Asudo",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)).toMatchObject({ value: "b".repeat(43), httpOnly: true, secure: true });
      expect(routeMocks.beginSudoReauthentication).toHaveBeenCalledWith(activeSession, "/security");
      expect(routeMocks.authenticateMutation).toHaveBeenCalledWith(
        "h".repeat(43),
        "session-bound-csrf",
        expect.objectContaining({ allowRotation: true }),
      );
    });

    it("falls back to the overview for an unknown return path and refuses foreign origins", async () => {
      await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=https%3A%2F%2Fattacker.invalid%2F"));
      expect(routeMocks.beginSudoReauthentication).toHaveBeenLastCalledWith(activeSession, "/");
      await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fadmin"));
      expect(routeMocks.beginSudoReauthentication).toHaveBeenLastCalledWith(activeSession, "/");

      const foreign = await reauthenticate(formRequest("csrfToken=session-bound-csrf", { origin: "https://attacker.invalid" }));
      expect(foreign.status).toBe(403);
      expect(routeMocks.beginSudoReauthentication).toHaveBeenCalledTimes(2);
    });

    it("returns to the page with sudo=unavailable when the provider cannot be reached", async () => {
      routeMocks.beginSudoReauthentication.mockRejectedValue(new Error("par failed"));
      const html = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity", { html: true }));
      expect(html.status).toBe(303);
      expect(html.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=unavailable");
      expect(html.headers.get("retry-after")).toBe("3");
      const json = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity"));
      expect(json.status).toBe(503);
      await expect(json.json()).resolves.toEqual({ error: "unavailable" });
    });

    it("rejects a missing or wrong CSRF proof without starting a transaction", async () => {
      routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
      const response = await reauthenticate(formRequest("csrfToken=forged&returnTo=%2Fsecurity", { html: true }));
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
      expect(routeMocks.beginSudoReauthentication).not.toHaveBeenCalled();
    });

    it("refuses the fallback for a person who has an in-product method", async () => {
      routeMocks.identity.mockResolvedValue(identityFixture);
      const json = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity"));
      expect(json.status).toBe(409);
      expect(json.headers.get("cache-control")).toBe("no-store");
      await expect(json.json()).resolves.toMatchObject({ error: "method_available" });
      const html = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity", { html: true }));
      expect(html.status).toBe(303);
      expect(html.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=method_available");
      expect(html.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
      expect(routeMocks.beginSudoReauthentication).not.toHaveBeenCalled();
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "method_available", sudoMethod: "reauth" }));

      routeMocks.identity.mockResolvedValue({
        ...noMethods,
        credentials: { password: false, totp: [], passkeys: [identityFixture.credentials.passkeys[0]] },
      });
      expect((await reauthenticate(formRequest("csrfToken=session-bound-csrf"))).status).toBe(409);
      // Legacy two-factor WebAuthn is not a passkey and does not block the fallback.
      routeMocks.identity.mockResolvedValue({
        ...noMethods,
        credentials: { password: false, totp: [], passkeys: [identityFixture.credentials.passkeys[1]] },
      });
      expect((await reauthenticate(formRequest("csrfToken=session-bound-csrf"))).status).toBe(303);
      expect(routeMocks.beginSudoReauthentication).toHaveBeenCalledTimes(1);
    });

    it("fails closed when the person's methods cannot be read", async () => {
      routeMocks.identity.mockRejectedValue(new SkyAccountUnavailableError());
      const html = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity", { html: true }));
      expect(html.status).toBe(303);
      expect(html.headers.get("location")).toBe("https://my.yildizskylab.com/security?sudo=unavailable");
      const json = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity"));
      expect(json.status).toBe(503);
      expect(routeMocks.beginSudoReauthentication).not.toHaveBeenCalled();

      routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
      const ended = await reauthenticate(formRequest("csrfToken=session-bound-csrf&returnTo=%2Fsecurity"));
      expect(ended.status).toBe(401);
      expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
      expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);
    });
  });
});
