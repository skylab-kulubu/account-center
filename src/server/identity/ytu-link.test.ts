// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import { POST as startYtuLink } from "@/app/api/account/identity/ytu-link/route";
import { OIDC_TRANSACTION_COOKIE, SESSION_COOKIE } from "@/server/auth/http";
import { logAuthEvent } from "@/server/auth/logging";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { completeYtuLink } from "@/server/identity/ytu-link";
import { SudoRequiredError } from "@/server/auth/sudo";
import { SkyAccountContractError, SkyAccountUnavailableError } from "@/server/sky-account/problem";

const routeMocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  revokeSession: vi.fn(),
  accessToken: vi.fn(),
  identity: vi.fn(),
  consumeKey: vi.fn(),
  beginYtuLink: vi.fn(),
  requireFreshSudo: vi.fn(),
  clearSudo: vi.fn(),
  config: { appUrl: new URL("https://my.yildizskylab.com") },
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: routeMocks.config,
    sessionAccess: { authenticateMutation: routeMocks.authenticateMutation },
    sessions: { revokeSession: routeMocks.revokeSession },
    account: { accessToken: routeMocks.accessToken },
    skyAccount: { identity: routeMocks.identity },
    anonymousRateLimit: { consumeKey: routeMocks.consumeKey },
    oidc: { beginYtuLink: routeMocks.beginYtuLink },
    sudo: { requireFreshSudo: routeMocks.requireFreshSudo, clearSudo: routeMocks.clearSudo },
  }),
}));

const activeSession = {
  id: "11111111-1111-4111-8111-111111111111",
  subject: "authenticated-subject",
  keycloakSid: "sid",
  createdAt: new Date("2026-09-22T08:00:00Z"),
  lastSeenAt: new Date("2026-09-22T09:00:00Z"),
  idleExpiresAt: new Date("2026-09-22T09:30:00Z"),
  absoluteExpiresAt: new Date("2026-09-22T16:00:00Z"),
};
const origin = "https://my.yildizskylab.com";
const authorizationUrl = "https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3Aytu";
const unverified = { ...identityFixture, verifiedYtu: false, nameLocked: false, schoolEmail: null };
const sudoToken = "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyJ9.signature-fixture";
const proof = { method: "password", sudoToken, expiresAt: new Date("2026-09-22T09:05:00Z") };

type RequestOptions = {
  origin?: string | null;
  csrf?: string | null;
  cookie?: boolean;
  contentType?: string;
  body?: string;
};

/** The page's start call: CSRF in the header, no body. */
function fetchRequest(options: RequestOptions = {}) {
  const headers = new Headers();
  if (options.cookie !== false) headers.set("cookie", `${SESSION_COOKIE}=${"h".repeat(43)}`);
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (options.csrf !== null) headers.set("x-csrf-token", options.csrf ?? "session-bound-csrf");
  if (options.contentType) headers.set("content-type", options.contentType);
  return new NextRequest(`${origin}/api/account/identity/ytu-link`, {
    method: "POST",
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

describe("POST /api/account/identity/ytu-link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession, rotated: false } });
    routeMocks.revokeSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.identity.mockResolvedValue(unverified);
    routeMocks.consumeKey.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 900 });
    routeMocks.clearSudo.mockResolvedValue(undefined);
    routeMocks.beginYtuLink.mockResolvedValue({ authorizationUrl: new URL(authorizationUrl), browserBinding: "b".repeat(43) });
    routeMocks.requireFreshSudo.mockResolvedValue(proof);
  });

  it("answers the Keycloak authorization URL and the transaction cookie after the Sudo mode gate", async () => {
    const response = await startYtuLink(fetchRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    await expect(response.json()).resolves.toEqual({ authorizationUrl });
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)).toMatchObject({ value: "b".repeat(43), httpOnly: true, secure: true });
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
    expect(routeMocks.authenticateMutation).toHaveBeenCalledWith(
      "h".repeat(43),
      "session-bound-csrf",
      expect.objectContaining({ allowRotation: true, requestId: "request-id" }),
    );
    expect(routeMocks.requireFreshSudo).toHaveBeenCalledWith(activeSession.id, { requestId: "request-id" });
    expect(routeMocks.consumeKey).toHaveBeenCalledWith("identity_mutation", activeSession.id);
    expect(routeMocks.identity).toHaveBeenCalledWith({ accessToken: "server-held-user-token" });
    expect(routeMocks.beginYtuLink).toHaveBeenCalledWith(activeSession);
    expect(logAuthEvent).toHaveBeenCalledWith({ event: "ytu_link_started", requestId: "request-id", outcome: "success" });
  });

  it("answers 428 sudo_required with the methods before the budget, the identity read or the transaction", async () => {
    routeMocks.requireFreshSudo.mockRejectedValue(new SudoRequiredError("missing", null));
    const response = await startYtuLink(fetchRequest());
    expect(response.status).toBe(428);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "sudo_required",
      reason: "missing",
      methods: ["password", "passkey", "totp"],
      fallback: null,
    });
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
    expect(routeMocks.consumeKey).not.toHaveBeenCalled();
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "ytu_link_started",
      outcome: "failure",
      reason: "sudo_required",
    }));
  });

  it("refuses a token-less Microsoft re-authentication proof with 428 spi_token_required", async () => {
    routeMocks.requireFreshSudo.mockResolvedValue({ method: "reauth", sudoToken: null, expiresAt: proof.expiresAt });
    routeMocks.identity.mockResolvedValue({ ...unverified, credentials: { password: false, totp: [], passkeys: [] } });
    const response = await startYtuLink(fetchRequest());
    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toEqual({
      error: "sudo_required",
      reason: "spi_token_required",
      methods: [],
      fallback: "microsoft",
    });
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
    // The proof is useless for the SPI, so it is dropped and the next attempt offers the fallback again.
    expect(routeMocks.clearSudo).toHaveBeenCalledWith(activeSession.id);
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "spi_token_required" }));
  });

  it("refuses a Verified YTÜ account with 409 already_linked before any transaction", async () => {
    routeMocks.identity.mockResolvedValue(identityFixture);
    const response = await startYtuLink(fetchRequest());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "already_linked", detail: "YTÜ hesabın zaten bağlı." });
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_started", reason: "already_linked" }));
  });

  it("requires the exact origin and the session CSRF proof before any work", async () => {
    for (const request of [fetchRequest({ origin: "https://attacker.invalid" }), fetchRequest({ origin: null })]) {
      const response = await startYtuLink(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();

    routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
    for (const request of [fetchRequest({ csrf: null }), fetchRequest({ csrf: "forged" })]) {
      const response = await startYtuLink(request);
      expect(response.status).toBe(403);
      expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
    }
    expect(routeMocks.authenticateMutation).toHaveBeenLastCalledWith("h".repeat(43), "forged", expect.anything());
    expect(routeMocks.requireFreshSudo).not.toHaveBeenCalled();
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", 401, false],
    ["blocked", 401, true],
    ["unavailable", 503, false],
  ] as const)("answers the %s session outcome with %d", async (status, expected, clears) => {
    routeMocks.authenticateMutation.mockResolvedValue({ status });
    const response = await startYtuLink(fetchRequest());
    expect(response.status).toBe(expected);
    expect(response.cookies.get(SESSION_COOKIE)?.value === "").toBe(clears);
    expect(routeMocks.identity).not.toHaveBeenCalled();
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
  });

  it("rejects oversized or foreign bodies without looking up the session", async () => {
    const cases = [
      fetchRequest({ contentType: "application/json", body: JSON.stringify({ padding: "x".repeat(2_000) }) }),
      fetchRequest({ contentType: "text/plain", body: "csrfToken=session-bound-csrf" }),
      fetchRequest({ contentType: "multipart/form-data; boundary=x", body: "--x--" }),
      fetchRequest({ contentType: "application/x-www-form-urlencoded", body: "csrfToken=session-bound-csrf" }),
    ];
    for (const request of cases) {
      const response = await startYtuLink(request);
      expect([400, 413]).toContain(response.status);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    }
    expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();

    // A small JSON body is tolerated; the proof is the header.
    const tolerated = await startYtuLink(fetchRequest({ contentType: "application/json", body: "{}" }));
    expect(tolerated.status).toBe(200);
  });

  it("stops at the local budget before reading the identity", async () => {
    routeMocks.consumeKey.mockResolvedValue({ allowed: false, count: 11, retryAfterSeconds: 420 });
    const response = await startYtuLink(fetchRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("420");
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 420 });
    expect(routeMocks.identity).not.toHaveBeenCalled();
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_started", reason: "rate_limited" }));
  });

  it("fails closed when the identity cannot be read or the provider cannot be reached", async () => {
    routeMocks.identity.mockRejectedValueOnce(new SkyAccountUnavailableError());
    const outage = await startYtuLink(fetchRequest());
    expect(outage.status).toBe(503);
    expect(outage.headers.get("retry-after")).toBe("3");
    await expect(outage.json()).resolves.toMatchObject({ error: "unavailable" });

    routeMocks.identity.mockRejectedValueOnce(new SkyAccountContractError());
    const drift = await startYtuLink(fetchRequest());
    expect(drift.status).toBe(502);
    await expect(drift.json()).resolves.toMatchObject({ error: "upstream_error" });

    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();

    routeMocks.beginYtuLink.mockRejectedValueOnce(new Error("par failed"));
    const par = await startYtuLink(fetchRequest());
    expect(par.status).toBe(503);
    expect(par.headers.get("retry-after")).toBe("3");
    await expect(par.json()).resolves.toMatchObject({ error: "unavailable" });
    expect(par.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_started", reason: "provider_unavailable" }));
  });

  it("ends the local session when the bearer can no longer be refreshed", async () => {
    routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
    const response = await startYtuLink(fetchRequest());
    expect(response.status).toBe(401);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(routeMocks.revokeSession).toHaveBeenCalledWith(activeSession.id);
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_started", reason: "invalid_token" }));
  });

  it("writes a rotated handle to every answer except one that ended the session", async () => {
    routeMocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotated: true, rotatedHandle: "rotated-handle-value" },
    });
    const started = await startYtuLink(fetchRequest());
    expect(started.cookies.get(SESSION_COOKIE)?.value).toBe("rotated-handle-value");

    routeMocks.identity.mockResolvedValueOnce(identityFixture);
    const alreadyLinked = await startYtuLink(fetchRequest());
    expect(alreadyLinked.status).toBe(409);
    expect(alreadyLinked.cookies.get(SESSION_COOKIE)?.value).toBe("rotated-handle-value");

    routeMocks.accessToken.mockRejectedValueOnce(new AccountReauthenticationRequiredError());
    const ended = await startYtuLink(fetchRequest());
    expect(ended.status).toBe(401);
    expect(ended.cookies.get(SESSION_COOKIE)?.value).toBe("");
  });

  it("never echoes tokens, the subject or the transaction binding in answers or logs", async () => {
    routeMocks.identity.mockResolvedValueOnce(identityFixture);
    const answers = [await startYtuLink(fetchRequest()), await startYtuLink(fetchRequest())];
    for (const answer of answers) {
      const text = `${[...answer.headers.entries()].join(";")} ${await answer.text()}`;
      expect(text).not.toContain("server-held-user-token");
      expect(text).not.toContain("authenticated-subject");
      expect(text).not.toContain("ada@");
    }
    for (const call of vi.mocked(logAuthEvent).mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("server-held-user-token");
      expect(serialized).not.toContain("authenticated-subject");
      expect(serialized).not.toContain("b".repeat(43));
    }
  });
});

describe("completeYtuLink", () => {
  const services = {
    account: { accessToken: routeMocks.accessToken },
    skyAccount: { identity: routeMocks.identity },
  } as unknown as Parameters<typeof completeYtuLink>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.accessToken.mockResolvedValue("fresh-server-token");
    routeMocks.identity.mockResolvedValue(identityFixture);
  });

  it("announces linked only when the re-read identity shows the link", async () => {
    await expect(completeYtuLink(services, activeSession, "success", "request-id")).resolves.toBe("linked");
    expect(routeMocks.accessToken).toHaveBeenCalledWith(activeSession);
    expect(routeMocks.identity).toHaveBeenCalledWith({ accessToken: "fresh-server-token" });
    expect(logAuthEvent).toHaveBeenCalledWith({ event: "ytu_link_completed", requestId: "request-id", outcome: "success" });

    routeMocks.identity.mockResolvedValue(unverified);
    await expect(completeYtuLink(services, activeSession, "success", "request-id")).resolves.toBe("unverified");
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_completed", reason: "link_unverified" }));

    routeMocks.identity.mockRejectedValue(new SkyAccountUnavailableError());
    await expect(completeYtuLink(services, activeSession, "success", "request-id")).resolves.toBe("unverified");
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_completed", reason: "provider_unavailable" }));

    routeMocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
    await expect(completeYtuLink(services, activeSession, "success", "request-id")).resolves.toBe("unverified");
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_completed", reason: "invalid_token" }));
  });

  it("passes a cancelled, failed or unstored outcome through without reading the identity", async () => {
    await expect(completeYtuLink(services, activeSession, "cancelled", "request-id")).resolves.toBe("cancelled");
    await expect(completeYtuLink(services, activeSession, "error", "request-id")).resolves.toBe("error");
    await expect(completeYtuLink(services, activeSession, "unverified", "request-id")).resolves.toBe("unverified");
    expect(routeMocks.identity).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "link_cancelled" }));
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "link_failed" }));
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "token_replace_failed" }));
  });
});
