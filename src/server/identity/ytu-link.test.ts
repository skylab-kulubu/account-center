// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import { POST as startYtuLink } from "@/app/api/account/identity/ytu-link/route";
import { OIDC_TRANSACTION_COOKIE, SESSION_COOKIE } from "@/server/auth/http";
import { logAuthEvent } from "@/server/auth/logging";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { completeYtuLink } from "@/server/identity/ytu-link";
import { SkyAccountContractError, SkyAccountUnavailableError } from "@/server/sky-account/problem";

const routeMocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  revokeSession: vi.fn(),
  accessToken: vi.fn(),
  identity: vi.fn(),
  consumeKey: vi.fn(),
  beginYtuLink: vi.fn(),
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

type RequestOptions = {
  origin?: string | null;
  csrf?: string | null;
  html?: boolean;
  cookie?: boolean;
  contentType?: string;
  body?: string;
};

/** A fetch caller: CSRF in the header, no body, no navigation headers. */
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

/** A browser form navigation: CSRF in the body, `Accept: text/html`. */
function formRequest(body: string, options: RequestOptions = {}) {
  const headers = new Headers({
    cookie: `${SESSION_COOKIE}=${"h".repeat(43)}`,
    origin: options.origin ?? origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    accept: "text/html,application/xhtml+xml",
    "content-type": "application/x-www-form-urlencoded",
  });
  return new NextRequest(`${origin}/api/account/identity/ytu-link`, { method: "POST", headers, body });
}

describe("POST /api/account/identity/ytu-link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession, rotated: false } });
    routeMocks.revokeSession.mockResolvedValue(true);
    routeMocks.accessToken.mockResolvedValue("server-held-user-token");
    routeMocks.identity.mockResolvedValue(unverified);
    routeMocks.consumeKey.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 900 });
    routeMocks.beginYtuLink.mockResolvedValue({ authorizationUrl: new URL(authorizationUrl), browserBinding: "b".repeat(43) });
  });

  it("answers a fetch caller with the Keycloak authorization URL and the transaction cookie", async () => {
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
    expect(routeMocks.consumeKey).toHaveBeenCalledWith("identity_mutation", activeSession.id);
    expect(routeMocks.identity).toHaveBeenCalledWith({ accessToken: "server-held-user-token" });
    expect(routeMocks.beginYtuLink).toHaveBeenCalledWith(activeSession);
    expect(logAuthEvent).toHaveBeenCalledWith({ event: "ytu_link_started", requestId: "request-id", outcome: "success" });
  });

  it("sends a form navigation straight to Keycloak with 303", async () => {
    const response = await startYtuLink(formRequest("csrfToken=session-bound-csrf"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(authorizationUrl);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("b".repeat(43));
    expect(routeMocks.authenticateMutation).toHaveBeenCalledWith("h".repeat(43), "session-bound-csrf", expect.anything());
  });

  it("refuses a Verified YTÜ account with 409 already_linked (a navigation returns to the page) before any transaction", async () => {
    routeMocks.identity.mockResolvedValue(identityFixture);
    const json = await startYtuLink(fetchRequest());
    expect(json.status).toBe(409);
    await expect(json.json()).resolves.toEqual({ error: "already_linked", detail: "YTÜ hesabın zaten bağlı." });
    expect(json.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();

    const html = await startYtuLink(formRequest("csrfToken=session-bound-csrf"));
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=already_linked");
    expect(html.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();

    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ytu_link_started", reason: "already_linked" }));
  });

  it("requires the exact origin and the session CSRF proof before any work", async () => {
    for (const request of [
      fetchRequest({ origin: "https://attacker.invalid" }),
      fetchRequest({ origin: null }),
      formRequest("csrfToken=session-bound-csrf", { origin: "https://evil.invalid" }),
    ]) {
      const response = await startYtuLink(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();

    routeMocks.authenticateMutation.mockResolvedValue({ status: "forbidden" });
    for (const request of [fetchRequest({ csrf: null }), fetchRequest({ csrf: "forged" }), formRequest("csrfToken=forged")]) {
      const response = await startYtuLink(request);
      expect(response.status).toBe(403);
      expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)).toBeUndefined();
    }
    expect(routeMocks.authenticateMutation).toHaveBeenLastCalledWith("h".repeat(43), "forged", expect.anything());
    expect(routeMocks.identity).not.toHaveBeenCalled();
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

  it("returns a navigation to the page with ytu=unavailable when the gate cannot decide", async () => {
    routeMocks.authenticateMutation.mockResolvedValue({ status: "unavailable" });
    const response = await startYtuLink(formRequest("csrfToken=session-bound-csrf"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=unavailable");
    expect(response.headers.get("retry-after")).toBe("3");
  });

  it("rejects oversized or foreign bodies without looking up the session", async () => {
    const cases = [
      fetchRequest({ contentType: "application/json", body: JSON.stringify({ padding: "x".repeat(2_000) }) }),
      fetchRequest({ contentType: "text/plain", body: "csrfToken=session-bound-csrf" }),
      fetchRequest({ contentType: "multipart/form-data; boundary=x", body: "--x--" }),
      formRequest(`csrfToken=${"c".repeat(2_000)}`),
    ];
    for (const request of cases) {
      const response = await startYtuLink(request);
      expect([400, 413]).toContain(response.status);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    }
    expect(routeMocks.authenticateMutation).not.toHaveBeenCalled();

    // A small JSON body from a fetch caller is tolerated; the proof is the header.
    const tolerated = await startYtuLink(fetchRequest({ contentType: "application/json", body: "{}" }));
    expect(tolerated.status).toBe(200);
  });

  it("stops at the local budget before reading the identity", async () => {
    routeMocks.consumeKey.mockResolvedValue({ allowed: false, count: 11, retryAfterSeconds: 420 });
    const json = await startYtuLink(fetchRequest());
    expect(json.status).toBe(429);
    expect(json.headers.get("retry-after")).toBe("420");
    await expect(json.json()).resolves.toMatchObject({ error: "rate_limited", retryAfter: 420 });

    const html = await startYtuLink(formRequest("csrfToken=session-bound-csrf"));
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=unavailable");
    expect(html.headers.get("retry-after")).toBe("420");

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

    routeMocks.identity.mockRejectedValueOnce(new SkyAccountUnavailableError());
    const navigation = await startYtuLink(formRequest("csrfToken=session-bound-csrf"));
    expect(navigation.status).toBe(303);
    expect(navigation.headers.get("location")).toBe("https://my.yildizskylab.com/identity?ytu=unavailable");
    expect(routeMocks.beginYtuLink).not.toHaveBeenCalled();

    routeMocks.beginYtuLink.mockRejectedValueOnce(new Error("par failed"));
    const par = await startYtuLink(fetchRequest());
    expect(par.status).toBe(503);
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

  it("passes a cancelled or failed action through without reading the identity", async () => {
    await expect(completeYtuLink(services, activeSession, "cancelled", "request-id")).resolves.toBe("cancelled");
    await expect(completeYtuLink(services, activeSession, "error", "request-id")).resolves.toBe("error");
    expect(routeMocks.identity).not.toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "link_cancelled" }));
    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "link_failed" }));
  });
});
