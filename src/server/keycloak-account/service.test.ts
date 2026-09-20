// @vitest-environment node

import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OidcTokenSet } from "@/server/auth/types";
import { AccountAccessTokenContractError } from "@/server/keycloak-account/access-token";
import { KeycloakAccountContractError } from "@/server/keycloak-account/schema";
import { AccountReadService } from "@/server/keycloak-account/service";
import type { KeycloakAccountReadAdapter } from "@/server/keycloak-account/types";

const now = new Date("2026-09-20T12:00:00Z");
const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");
const session = { id: "local-session", subject: "user-id" };

function jwt(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: issuer.href,
    sub: session.subject,
    azp: "account-center",
    aud: "account",
    scope: "openid",
    exp: Math.floor(now.getTime() / 1_000) + 300,
    ...overrides,
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function tokenSet(accessToken = jwt()): OidcTokenSet {
  return {
    accessToken,
    refreshToken: "server-only-refresh-token",
    idToken: "server-only-id-token",
    tokenType: "bearer",
  };
}

function fixture(initial = tokenSet()) {
  let stored = { tokens: initial, version: "encrypted-v1" };
  const reference = (localSessionId: string, upstreamSessionId: string) =>
    createHmac("sha256", "test-reference-key")
      .update(`${localSessionId}\0${upstreamSessionId}`)
      .digest("base64url");
  const vault = {
    readTokens: vi.fn(async () => stored),
    replaceTokens: vi.fn(async (_id: string, version: string, tokens: OidcTokenSet) => {
      if (version !== stored.version) return false;
      stored = { tokens, version: "encrypted-v2" };
      return true;
    }),
    upstreamSessionReference: vi.fn(reference),
    verifyUpstreamSessionReference: vi.fn((localSessionId: string, upstreamSessionId: string, candidate: string) => {
      const expected = Buffer.from(reference(localSessionId, upstreamSessionId));
      const received = Buffer.from(candidate);
      return expected.length === received.length && timingSafeEqual(expected, received);
    }),
  };
  const adapter = {
    profile: vi.fn().mockResolvedValue({ firstName: "Ada", lastName: "Lovelace", email: "a@example.invalid", emailVerified: true }),
    authentication: vi.fn().mockResolvedValue({ passwordConfigured: true, otpConfigured: false, passkeyCount: 1 }),
    sessions: vi.fn().mockResolvedValue([]),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    revokeOtherSessions: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue({
      profile: { firstName: "Ada", lastName: "Lovelace", email: "a@example.invalid", emailVerified: true },
      authentication: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
      sessions: [],
    }),
  } satisfies KeycloakAccountReadAdapter;
  const oidc = {
    refresh: vi.fn().mockResolvedValue(tokenSet(jwt({ exp: Math.floor(now.getTime() / 1_000) + 600 }))),
    revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new AccountReadService(adapter, vault, oidc, { issuer, clientId: "account-center" }, () => now),
    adapter,
    oidc,
    vault,
  };
}

describe("AccountReadService", () => {
  it("uses the encrypted user-session access token and does not refresh a current token", async () => {
    const { service, adapter, oidc } = fixture();
    await expect(service.profile(session)).resolves.toMatchObject({ firstName: "Ada" });
    expect(adapter.profile).toHaveBeenCalledWith(expect.stringContaining("."));
    expect(oidc.refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired user token and compare-and-swaps encrypted token material", async () => {
    const expired = tokenSet(jwt({ exp: Math.floor(now.getTime() / 1_000) - 1 }));
    const { service, oidc, vault } = fixture(expired);
    await expect(service.authentication(session)).resolves.toMatchObject({ passwordConfigured: true });
    expect(oidc.refresh).toHaveBeenCalledWith(expired);
    expect(vault.replaceTokens).toHaveBeenCalledWith(
      session.id,
      "encrypted-v1",
      expect.objectContaining({ accessToken: expect.any(String) }),
    );
  });

  it("rejects non-account or multi-audience tokens before any Account REST request", async () => {
    const { service, adapter } = fixture(tokenSet(jwt({ aud: ["account", "core"] })));
    await expect(service.profile(session)).rejects.toBeInstanceOf(AccountAccessTokenContractError);
    expect(adapter.profile).not.toHaveBeenCalled();
  });

  it("does not persist a refreshed token that drifts from the Account REST contract", async () => {
    const expired = tokenSet(jwt({ exp: Math.floor(now.getTime() / 1_000) - 1 }));
    const { service, adapter, oidc, vault } = fixture(expired);
    oidc.refresh.mockResolvedValue(tokenSet(jwt({ aud: ["account", "core"] })));

    await expect(service.profile(session)).rejects.toBeInstanceOf(AccountAccessTokenContractError);
    expect(vault.replaceTokens).not.toHaveBeenCalled();
    expect(oidc.revokeRefreshToken).toHaveBeenCalledWith("server-only-refresh-token");
    expect(adapter.profile).not.toHaveBeenCalled();
  });

  it("returns browser-safe session references instead of Keycloak session ids", async () => {
    const { service, adapter } = fixture();
    adapter.sessions.mockResolvedValue([
      {
        id: "keycloak-current-secret",
        startedAt: "2026-09-20T08:00:00.000Z",
        lastAccessAt: "2026-09-20T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: "Chrome/140.0",
        current: true,
        device: null,
      },
      {
        id: "keycloak-other-secret",
        startedAt: "2026-09-19T08:00:00.000Z",
        lastAccessAt: "2026-09-19T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: "Safari/26.0",
        current: false,
        device: null,
      },
    ]);

    const managed = await service.managedSessions(session);

    expect(managed).toEqual([
      expect.objectContaining({ current: true, reference: null }),
      expect.objectContaining({ current: false, reference: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }),
    ]);
    expect(JSON.stringify(managed)).not.toContain("keycloak-current-secret");
    expect(JSON.stringify(managed)).not.toContain("keycloak-other-secret");
  });

  it("keeps Keycloak session ids out of the combined browser snapshot", async () => {
    const { service, adapter } = fixture();
    adapter.snapshot.mockResolvedValue({
      profile: { firstName: "Ada", lastName: "Lovelace", email: "a@example.invalid", emailVerified: true },
      authentication: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
      sessions: [{
        id: "keycloak-session-secret",
        startedAt: "2026-09-20T08:00:00.000Z",
        lastAccessAt: "2026-09-20T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: null,
        current: true,
        device: null,
      }],
    });

    const snapshot = await service.snapshot(session);

    expect(snapshot.sessions[0]).toMatchObject({ reference: null, current: true });
    expect(JSON.stringify(snapshot)).not.toContain("keycloak-session-secret");
  });

  it("revokes only a non-current session selected from the authenticated user's live list", async () => {
    const { service, adapter } = fixture();
    adapter.sessions.mockResolvedValue([
      {
        id: "current-upstream",
        startedAt: "2026-09-20T08:00:00.000Z",
        lastAccessAt: "2026-09-20T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: null,
        current: true,
        device: null,
      },
      {
        id: "other-upstream",
        startedAt: "2026-09-19T08:00:00.000Z",
        lastAccessAt: "2026-09-19T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: null,
        current: false,
        device: null,
      },
    ]);
    const listed = await service.managedSessions(session);
    const other = listed.find((candidate) => !candidate.current);

    await expect(service.revokeOtherSession(session, other?.reference ?? "")).resolves.toBeUndefined();

    expect(adapter.revokeSession).toHaveBeenCalledWith(expect.any(String), "other-upstream");
  });

  it("idempotently ignores malformed, foreign, missing, and current-session references", async () => {
    const { service, adapter } = fixture();
    adapter.sessions.mockResolvedValue([
      {
        id: "current-upstream",
        startedAt: "2026-09-20T08:00:00.000Z",
        lastAccessAt: "2026-09-20T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: null,
        current: true,
        device: null,
      },
    ]);

    await service.revokeOtherSession(session, "not-a-reference");
    await service.revokeOtherSession(session, "x".repeat(43));

    expect(adapter.revokeSession).not.toHaveBeenCalled();
  });

  it("revokes all sessions except the Account REST current session", async () => {
    const { service, adapter } = fixture();
    adapter.sessions.mockResolvedValue([
      {
        id: "current-upstream",
        startedAt: "2026-09-20T08:00:00.000Z",
        lastAccessAt: "2026-09-20T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: null,
        current: true,
        device: null,
      },
      {
        id: "other-upstream",
        startedAt: "2026-09-19T08:00:00.000Z",
        lastAccessAt: "2026-09-19T10:00:00.000Z",
        expiresAt: "2026-09-20T16:00:00.000Z",
        browser: null,
        current: false,
        device: null,
      },
    ]);

    await expect(service.revokeOtherSessions(session)).resolves.toBeUndefined();

    expect(adapter.revokeOtherSessions).toHaveBeenCalledWith(expect.any(String));
  });

  it.each([
    ["zero", false, false],
    ["multiple", true, true],
  ] as const)(
    "fails closed before exposing references or mutating when %s sessions are current",
    async (_label, firstCurrent, secondCurrent) => {
      const { service, adapter, vault } = fixture();
      adapter.sessions.mockResolvedValue([
        {
          id: "upstream-one",
          startedAt: "2026-09-20T08:00:00.000Z",
          lastAccessAt: "2026-09-20T10:00:00.000Z",
          expiresAt: "2026-09-20T16:00:00.000Z",
          browser: null,
          current: firstCurrent,
          device: null,
        },
        {
          id: "upstream-two",
          startedAt: "2026-09-19T08:00:00.000Z",
          lastAccessAt: "2026-09-19T10:00:00.000Z",
          expiresAt: "2026-09-20T16:00:00.000Z",
          browser: null,
          current: secondCurrent,
          device: null,
        },
      ]);

      await expect(service.managedSessions(session)).rejects.toBeInstanceOf(KeycloakAccountContractError);
      await expect(service.revokeOtherSession(session, "x".repeat(43)))
        .rejects.toBeInstanceOf(KeycloakAccountContractError);
      await expect(service.revokeOtherSessions(session))
        .rejects.toBeInstanceOf(KeycloakAccountContractError);

      expect(vault.upstreamSessionReference).not.toHaveBeenCalled();
      expect(adapter.revokeSession).not.toHaveBeenCalled();
      expect(adapter.revokeOtherSessions).not.toHaveBeenCalled();
    },
  );

  it("keeps a genuinely empty upstream list idempotent and mutation-free", async () => {
    const { service, adapter } = fixture();

    await expect(service.managedSessions(session)).resolves.toEqual([]);
    await expect(service.revokeOtherSession(session, "x".repeat(43))).resolves.toBeUndefined();
    await expect(service.revokeOtherSessions(session)).resolves.toBeUndefined();

    expect(adapter.revokeSession).not.toHaveBeenCalled();
    expect(adapter.revokeOtherSessions).not.toHaveBeenCalled();
  });
});
