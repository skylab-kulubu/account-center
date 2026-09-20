// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { OidcTokenSet } from "@/server/auth/types";
import { AccountAccessTokenContractError } from "@/server/keycloak-account/access-token";
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
  const vault = {
    readTokens: vi.fn(async () => stored),
    replaceTokens: vi.fn(async (_id: string, version: string, tokens: OidcTokenSet) => {
      if (version !== stored.version) return false;
      stored = { tokens, version: "encrypted-v2" };
      return true;
    }),
    credentialReference: vi.fn(() => "r".repeat(43)),
  };
  const adapter = {
    profile: vi.fn().mockResolvedValue({ firstName: "Ada", lastName: "Lovelace", email: "a@example.invalid", emailVerified: true }),
    authentication: vi.fn().mockResolvedValue({ passwordConfigured: true, otpConfigured: false, passkeyCount: 1 }),
    credentialInventory: vi.fn().mockResolvedValue({
      summary: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
      credentials: [],
    }),
    sessions: vi.fn().mockResolvedValue([]),
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

  it("maps removable credentials to session-bound opaque references", async () => {
    const { service, adapter, vault } = fixture();
    adapter.credentialInventory.mockResolvedValue({
      summary: { passwordConfigured: true, otpConfigured: true, passkeyCount: 1 },
      credentials: [
        {
          id: "credential-passkey-one",
          type: "webauthn-passwordless",
          label: "MacBook Touch ID",
          createdAt: "2026-09-20T09:00:00.000Z",
          removeable: true,
        },
        {
          id: "credential-password-id",
          type: "password",
          label: null,
          createdAt: null,
          removeable: false,
        },
      ],
    });

    const security = await service.security(session);

    expect(security.credentials).toEqual([expect.objectContaining({
      kind: "passkey",
      label: "MacBook Touch ID",
      deletionReference: "r".repeat(43),
    })]);
    expect(vault.credentialReference).toHaveBeenCalledWith(
      session.id,
      "credential-passkey-one",
    );
    expect(JSON.stringify(security)).not.toContain("credential-passkey-one");
    expect(JSON.stringify(security)).not.toContain("credential-password-id");
  });
});
