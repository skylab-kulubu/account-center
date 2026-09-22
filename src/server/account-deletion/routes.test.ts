// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as prepare } from "@/app/api/account/deletion/prepare/route";
import { POST as reauthenticate } from "@/app/api/account/deletion/reauthenticate/route";
import { POST as submit } from "@/app/api/account/deletion/route";
import { GET as status } from "@/app/api/account/deletion/status/route";
import { POST as retry } from "@/app/api/account/deletion/status/retry/route";
import {
  ACCOUNT_DELETION_PROOF_COOKIE,
  ACCOUNT_DELETION_RECEIPT_COOKIE,
  OIDC_TRANSACTION_COOKIE,
  SESSION_COOKIE,
} from "@/server/auth/http";
import { AccountDeletionProofError, AccountDeletionUnavailableError } from "@/server/account-deletion/orchestrator";
import { SudoRequiredError } from "@/server/auth/sudo";

const mocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  beginReauthentication: vi.fn(),
  createReauthenticatedIntent: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
  retry: vi.fn(),
  receiptCsrfToken: vi.fn(),
  verifyReceiptCsrf: vi.fn(),
  requireFreshSudo: vi.fn(),
  clearSudo: vi.fn(),
  accessToken: vi.fn(),
  identity: vi.fn(),
  readTokens: vi.fn(),
}));

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({
    config: {
      appUrl: new URL("https://my.yildizskylab.com"),
      issuer: new URL("https://e.yildizskylab.com/realms/e-skylab"),
      clientId: "account-center",
    },
    sessionAccess: { authenticateMutation: mocks.authenticateMutation },
    sessions: { readTokens: mocks.readTokens },
    account: { accessToken: mocks.accessToken },
    skyAccount: { identity: mocks.identity },
    sudo: { requireFreshSudo: mocks.requireFreshSudo, clearSudo: mocks.clearSudo },
    oidc: { beginAccountDeletionReauthentication: mocks.beginReauthentication },
    accountDeletion: {
      createReauthenticatedIntent: mocks.createReauthenticatedIntent,
      submit: mocks.submit,
      status: mocks.status,
      retry: mocks.retry,
      receiptCsrfToken: mocks.receiptCsrfToken,
      verifyReceiptCsrf: mocks.verifyReceiptCsrf,
    },
  }),
}));

const activeSession = {
  id: "11111111-1111-4111-8111-111111111111",
  subject: "server-session-subject",
  keycloakSid: "sid",
  createdAt: new Date("2026-09-20T10:00:00Z"),
  lastSeenAt: new Date("2026-09-20T12:00:00Z"),
  idleExpiresAt: new Date("2026-09-20T12:30:00Z"),
  absoluteExpiresAt: new Date("2026-09-20T18:00:00Z"),
};
const handle = "h".repeat(43);
const proof = "p".repeat(43);
const localReceipt = "l".repeat(43);
const coreReceipt = `adr_${"r".repeat(43)}`;

function mutation(path: string, body = "csrfToken=csrf", cookie = `${SESSION_COOKIE}=${handle}`) {
  return new NextRequest(`https://my.yildizskylab.com${path}`, {
    method: "POST",
    body,
    headers: {
      origin: "https://my.yildizskylab.com",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
  });
}

/** `POST .../deletion/prepare` is a same-origin fetch that proves CSRF with the header. */
function jsonMutation(path: string, cookie = `${SESSION_COOKIE}=${handle}`) {
  return new NextRequest(`https://my.yildizskylab.com${path}`, {
    method: "POST",
    headers: {
      origin: "https://my.yildizskylab.com",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": "csrf",
      cookie,
    },
  });
}

/** An ID token in the shape core verifies on the intake; only the claims are read. */
function idToken(claims: Record<string, unknown> = {}) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1_000);
  return [
    part({ alg: "RS256", typ: "JWT" }),
    part({
      iss: "https://e.yildizskylab.com/realms/e-skylab",
      sub: activeSession.subject,
      aud: "account-center",
      sid: "keycloak-session",
      auth_time: issuedAt - 30,
      exp: issuedAt + 300,
      ...claims,
    }),
    "signature-fixture",
  ].join(".");
}

function navigationMutation(
  path: string,
  body = "csrfToken=csrf",
  cookie = `${SESSION_COOKIE}=${handle}`,
) {
  const request = mutation(path, body, cookie);
  request.headers.set("accept", "text/html,application/xhtml+xml");
  request.headers.set("sec-fetch-mode", "navigate");
  request.headers.set("sec-fetch-dest", "document");
  return request;
}

describe("account deletion BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: { session: activeSession, rotated: false },
    });
    mocks.beginReauthentication.mockResolvedValue({
      authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?request_uri=urn%3Apar%3Adelete"),
      browserBinding: "b".repeat(43),
    });
    mocks.submit.mockResolvedValue({
      status: "processing",
      partial: true,
      updatedAt: "2026-09-20T12:00:02.000Z",
      completedAt: null,
      receiptExpiresAt: "2026-10-20T12:00:01.000Z",
      receipt: coreReceipt,
    });
    mocks.status.mockResolvedValue({
      status: "processing",
      partial: true,
      updatedAt: "2026-09-20T12:00:02.000Z",
      completedAt: null,
      receiptExpiresAt: "2026-10-20T12:00:01.000Z",
      receipt: coreReceipt,
    });
    mocks.retry.mockResolvedValue({
      status: "pending",
      partial: true,
      updatedAt: "2026-09-20T12:00:03.000Z",
      completedAt: null,
      receiptExpiresAt: "2026-10-20T12:00:01.000Z",
      receipt: coreReceipt,
    });
    mocks.receiptCsrfToken.mockReturnValue("receipt-csrf");
    mocks.verifyReceiptCsrf.mockReturnValue(true);
    mocks.requireFreshSudo.mockResolvedValue({
      method: "password",
      sudoToken: "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyJ9.signature-fixture",
      expiresAt: new Date(Date.now() + 4 * 60_000),
    });
    mocks.identity.mockResolvedValue({
      credentials: { password: true, passkeys: [], totp: [] },
    });
    mocks.accessToken.mockResolvedValue("account-rest-access-token");
    mocks.readTokens.mockResolvedValue({
      tokens: { accessToken: "stored-access-token", idToken: idToken(), tokenType: "bearer" },
      version: "ciphertext",
    });
    mocks.createReauthenticatedIntent.mockResolvedValue({
      proofReference: proof,
      localReceipt,
      freshUntil: new Date(Date.now() + 5 * 60_000),
    });
  });

  it("prepares the confirmation from a fresh session ID token, without a Keycloak hop", async () => {
    const response = await prepare(jsonMutation("/api/account/deletion/prepare"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ step: "confirm" });
    expect(mocks.createReauthenticatedIntent).toHaveBeenCalledWith({
      session: activeSession,
      authenticatedAt: expect.any(Date),
      freshAccessToken: "account-rest-access-token",
      freshIdToken: expect.stringContaining("."),
    });
    expect(response.cookies.get(ACCOUNT_DELETION_PROOF_COOKIE)?.value).toBe(proof);
    expect(response.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)?.value).toBe(localReceipt);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.beginReauthentication).not.toHaveBeenCalled();
  });

  it("keeps the Keycloak hop when the session holds no fresh enough ID token", async () => {
    mocks.readTokens.mockResolvedValue({
      tokens: {
        accessToken: "stored-access-token",
        idToken: idToken({ auth_time: Math.floor(Date.now() / 1_000) - 3_600 }),
        tokenType: "bearer",
      },
      version: "ciphertext",
    });

    const response = await prepare(jsonMutation("/api/account/deletion/prepare"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ step: "keycloak_reauthentication" });
    expect(mocks.createReauthenticatedIntent).not.toHaveBeenCalled();
    // The hop answer costs nothing upstream: no bearer is fetched or refreshed.
    expect(mocks.accessToken).not.toHaveBeenCalled();
    expect(response.cookies.get(ACCOUNT_DELETION_PROOF_COOKIE)).toBeUndefined();
    expect(response.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)).toBeUndefined();
  });

  it("prepares and submits nothing without a fresh Sudo mode proof", async () => {
    mocks.requireFreshSudo.mockRejectedValue(new SudoRequiredError("expired", null));

    const challenge = await prepare(jsonMutation("/api/account/deletion/prepare"));
    expect(challenge.status).toBe(428);
    await expect(challenge.json()).resolves.toEqual({
      error: "sudo_required",
      reason: "expired",
      methods: ["password"],
      fallback: null,
    });
    expect(mocks.createReauthenticatedIntent).not.toHaveBeenCalled();

    const cookies = `${SESSION_COOKIE}=${handle}; ${ACCOUNT_DELETION_PROOF_COOKIE}=${proof}; ${ACCOUNT_DELETION_RECEIPT_COOKIE}=${localReceipt}`;
    const browserResponse = await submit(navigationMutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=HESABIMI+S%C4%B0L",
      cookies,
    ));
    expect(browserResponse.status).toBe(303);
    expect(browserResponse.headers.get("location")).toBe(
      "https://my.yildizskylab.com/delete-account?deletionError=sudo_required",
    );
    expect(browserResponse.cookies.get(ACCOUNT_DELETION_PROOF_COOKIE)).toBeUndefined();
    expect(browserResponse.cookies.get(SESSION_COOKIE)).toBeUndefined();

    const apiResponse = await submit(mutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=HESABIMI+S%C4%B0L",
      cookies,
    ));
    expect(apiResponse.status).toBe(428);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("starts forced reauthentication only after exact origin, session CSRF, and access gate", async () => {
    const response = await reauthenticate(mutation("/api/account/deletion/reauthenticate"));
    expect(response.status).toBe(303);
    expect(response.cookies.get(OIDC_TRANSACTION_COOKIE)?.value).toBe("b".repeat(43));
    expect(mocks.beginReauthentication).toHaveBeenCalledWith(activeSession);

    const crossOrigin = mutation("/api/account/deletion/reauthenticate");
    crossOrigin.headers.set("origin", "https://evil.invalid");
    expect((await reauthenticate(crossOrigin)).status).toBe(403);
  });

  it("preserves a rotated session when reauthentication initiation fails", async () => {
    mocks.authenticateMutation.mockResolvedValue({
      status: "active",
      value: {
        session: activeSession,
        rotated: true,
        rotatedHandle: "n".repeat(43),
      },
    });
    mocks.beginReauthentication.mockRejectedValue(new Error("provider unavailable"));

    const browserResponse = await reauthenticate(navigationMutation(
      "/api/account/deletion/reauthenticate",
    ));
    expect(browserResponse.status).toBe(303);
    expect(browserResponse.headers.get("location")).toBe(
      "https://my.yildizskylab.com/delete-account?deletionError=reauth_unavailable",
    );
    expect(browserResponse.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));

    const apiResponse = await reauthenticate(mutation("/api/account/deletion/reauthenticate"));
    expect(apiResponse.status).toBe(503);
    expect(apiResponse.cookies.get(SESSION_COOKIE)?.value).toBe("n".repeat(43));
    await expect(apiResponse.json()).resolves.toEqual({ error: "unavailable" });
  });

  it("submits no subject, replaces the local receipt, clears proof/session cookies, and redirects public status", async () => {
    const cookies = `${SESSION_COOKIE}=${handle}; ${ACCOUNT_DELETION_PROOF_COOKIE}=${proof}; ${ACCOUNT_DELETION_RECEIPT_COOKIE}=${localReceipt}`;
    const response = await submit(navigationMutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=HESABIMI+S%C4%B0L",
      cookies,
    ));

    expect(mocks.submit).toHaveBeenCalledWith({
      session: activeSession,
      proofReference: proof,
      localReceipt,
      confirmation: "HESABIMI SİL",
    });
    expect(mocks.submit.mock.calls[0]?.[0].session).toBe(activeSession);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://my.yildizskylab.com/account-deletion");
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(ACCOUNT_DELETION_PROOF_COOKIE)?.value).toBe("");
    expect(response.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)?.value).toBe(coreReceipt);
  });

  it("redirects an expired browser proof to branded recovery but preserves API 400 semantics", async () => {
    mocks.submit.mockRejectedValue(new AccountDeletionProofError());
    const cookies = `${SESSION_COOKIE}=${handle}; ${ACCOUNT_DELETION_PROOF_COOKIE}=${proof}; ${ACCOUNT_DELETION_RECEIPT_COOKIE}=${localReceipt}`;
    const browserResponse = await submit(navigationMutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=HESABIMI+S%C4%B0L",
      cookies,
    ));
    expect(browserResponse.status).toBe(303);
    expect(browserResponse.headers.get("location")).toBe(
      "https://my.yildizskylab.com/delete-account?deletionError=proof_expired",
    );
    expect(browserResponse.cookies.get(ACCOUNT_DELETION_PROOF_COOKIE)?.value).toBe("");
    expect(browserResponse.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)?.value).toBe("");
    expect(browserResponse.cookies.get(SESSION_COOKIE)).toBeUndefined();

    const apiResponse = await submit(mutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=HESABIMI+S%C4%B0L",
      cookies,
    ));
    expect(apiResponse.status).toBe(400);
    await expect(apiResponse.json()).resolves.toEqual({ error: "invalid_request" });

    const ambiguous = mutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=HESABIMI+S%C4%B0L",
      cookies,
    );
    ambiguous.headers.set("accept", "text/html");
    expect((await submit(ambiguous)).status).toBe(400);
  });

  it("keeps the pre-issued local receipt when Core acceptance is uncertain", async () => {
    mocks.submit.mockRejectedValue(new AccountDeletionUnavailableError());
    const cookies = `${SESSION_COOKIE}=${handle}; ${ACCOUNT_DELETION_PROOF_COOKIE}=${proof}; ${ACCOUNT_DELETION_RECEIPT_COOKIE}=${localReceipt}`;
    const response = await submit(navigationMutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=HESABIMI+S%C4%B0L",
      cookies,
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://my.yildizskylab.com/account-deletion?recovery=1",
    );
    expect(response.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)).toBeUndefined();
    expect(response.cookies.get(ACCOUNT_DELETION_PROOF_COOKIE)).toBeUndefined();
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("recovers status sessionlessly from the HttpOnly receipt and rotates it without exposing it", async () => {
    const response = await status(new NextRequest(
      "https://my.yildizskylab.com/api/account/deletion/status",
      { headers: { cookie: `${ACCOUNT_DELETION_RECEIPT_COOKIE}=${localReceipt}` } },
    ));
    expect(mocks.status).toHaveBeenCalledWith(localReceipt);
    expect(response.cookies.get(ACCOUNT_DELETION_RECEIPT_COOKIE)?.value).toBe(coreReceipt);
    await expect(response.json()).resolves.toEqual({
      status: "processing",
      partial: true,
      updatedAt: "2026-09-20T12:00:02.000Z",
      completedAt: null,
      csrfToken: "receipt-csrf",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("retries manual intervention only with exact origin and receipt-bound CSRF", async () => {
    const request = new NextRequest("https://my.yildizskylab.com/api/account/deletion/status/retry", {
      method: "POST",
      headers: {
        origin: "https://my.yildizskylab.com",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "receipt-csrf",
        cookie: `${ACCOUNT_DELETION_RECEIPT_COOKIE}=${coreReceipt}`,
      },
    });
    const response = await retry(request);
    expect(response.status).toBe(200);
    expect(mocks.verifyReceiptCsrf).toHaveBeenCalledWith(coreReceipt, "receipt-csrf");
    expect(mocks.retry).toHaveBeenCalledWith(coreReceipt);
    expect(JSON.stringify(await response.json())).not.toContain(coreReceipt);

    mocks.verifyReceiptCsrf.mockReturnValue(false);
    const forged = new NextRequest(request.url, {
      method: "POST",
      headers: request.headers,
    });
    expect((await retry(forged)).status).toBe(403);
  });

  it("maps proof errors generically and never calls Core for blocked/unavailable sessions", async () => {
    mocks.submit.mockRejectedValue(new AccountDeletionProofError());
    const cookies = `${SESSION_COOKIE}=${handle}; ${ACCOUNT_DELETION_PROOF_COOKIE}=${proof}; ${ACCOUNT_DELETION_RECEIPT_COOKIE}=${localReceipt}`;
    expect((await submit(mutation(
      "/api/account/deletion",
      "csrfToken=csrf&confirmation=wrong",
      cookies,
    ))).status).toBe(400);

    mocks.authenticateMutation.mockResolvedValue({ status: "unavailable" });
    expect((await reauthenticate(mutation("/api/account/deletion/reauthenticate"))).status).toBe(503);
    mocks.authenticateMutation.mockResolvedValue({ status: "blocked" });
    expect((await reauthenticate(mutation("/api/account/deletion/reauthenticate"))).status).toBe(401);
    expect(mocks.beginReauthentication).not.toHaveBeenCalled();
  });
});
