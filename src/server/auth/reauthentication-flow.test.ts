// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import { InvalidOidcTransactionError, OidcFlowService } from "@/server/auth/oidc-flow";
import type {
  AuthorizationResult,
  BeginAuthorizationInput,
  ExchangeAuthorizationInput,
  OidcProtocol,
} from "@/server/auth/oidc-protocol";
import type { OidcTransactionRepository } from "@/server/auth/repositories";
import { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import type { ActiveSession, StoredOidcTransaction } from "@/server/auth/types";

const now = new Date("2026-09-20T12:00:00.000Z");
const handle = "h".repeat(43);
const activeSession: ActiveSession = {
  id: "d9a9bb4a-4977-4f07-8eb7-d3ba5c45e5cd",
  subject: "user-id",
  keycloakSid: "keycloak-session",
  createdAt: new Date("2026-09-20T11:00:00.000Z"),
  lastSeenAt: new Date("2026-09-20T11:59:00.000Z"),
  idleExpiresAt: new Date("2026-09-20T12:30:00.000Z"),
  absoluteExpiresAt: new Date("2026-09-20T18:00:00.000Z"),
};

class MemoryTransactions implements OidcTransactionRepository {
  rows = new Map<string, StoredOidcTransaction & { consumed?: boolean }>();

  async insert(value: StoredOidcTransaction) {
    this.rows.set(value.stateHash.toString("hex"), value);
  }

  async consume(stateHash: Buffer, browserBindingHash: Buffer, current: Date) {
    const row = this.rows.get(stateHash.toString("hex"));
    if (!row || row.consumed || row.expiresAt <= current || !row.browserBindingHash.equals(browserBindingHash)) {
      return null;
    }
    row.consumed = true;
    return { id: row.id, payloadCiphertext: row.payloadCiphertext };
  }
}

class FakeProtocol implements OidcProtocol {
  proof?: BeginAuthorizationInput;
  exchanged?: ExchangeAuthorizationInput;
  authorization: AuthorizationResult = {
    subject: activeSession.subject,
    keycloakSid: activeSession.keycloakSid ?? undefined,
    authenticatedAt: now,
    tokens: {
      accessToken: "fresh-server-access-token",
      refreshToken: "fresh-server-refresh-token",
      idToken: "fresh-server-id-token",
      tokenType: "bearer",
    },
  };

  async begin(input: BeginAuthorizationInput) {
    this.proof = input;
    return {
      authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3Aaction"),
      expiresIn: 90,
    };
  }

  async exchange(input: ExchangeAuthorizationInput) {
    this.exchanged = input;
    return this.authorization;
  }

  async refresh(): Promise<never> { throw new Error("not used"); }
  async revokeRefreshToken() {}
}

function fixture() {
  const protocol = new FakeProtocol();
  const sessions = {
    candidate: vi.fn(async (candidate: string | undefined) => candidate === handle ? activeSession : null),
    authenticate: vi.fn(async (candidate: string | undefined) => candidate === handle
      ? { session: activeSession, rotated: false }
      : null),
    create: vi.fn(),
    readTokens: vi.fn(async () => ({
      tokens: { accessToken: "old", idToken: "old", tokenType: "bearer" },
      version: "encrypted-v1",
    })),
    replaceTokens: vi.fn(async () => true),
  };
  const accountAccess = { requireActive: vi.fn(async () => undefined) };
  const flow = new OidcFlowService(
    protocol,
    new OidcTransactionStore(
      new MemoryTransactions(),
      new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      300,
      () => now,
    ),
    sessions,
    accountAccess,
    { ytuIdpAlias: "OBS", clock: () => now },
  );
  return { flow, protocol, sessions, accountAccess };
}

/**
 * The forced Microsoft re-authentication (`prompt=login&max_age=0`) behind
 * Sudo mode's fallback; account deletion has no hop of its own any more. No
 * Keycloak account action is ever requested: credential changes run through
 * the sky-account SPI.
 */
describe("Account Center forced re-authentication", () => {
  it("re-authenticates for sudo with a forced login bound to the session and returns the auth_time", async () => {
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginSudoReauthentication(activeSession, "/security");
    expect(protocol.proof).toMatchObject({ forceReauthentication: true });
    expect(Object.keys(protocol.proof!).sort()).toEqual(["codeVerifier", "forceReauthentication", "nonce", "state"]);
    expect(started.authorizationUrl.href).not.toContain(activeSession.subject);

    const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", protocol.proof!.state);
    const result = await flow.callback(callback, started.browserBinding, handle);

    expect(result).toEqual({
      sudoReauthentication: "success",
      session: activeSession,
      authenticatedAt: now,
      freshIdToken: "fresh-server-id-token",
      returnTo: "/security",
    });
    // Only the ID token travels on (the proof for `POST sudo/authentication`); the rest stays encrypted.
    expect(JSON.stringify(result)).not.toContain("fresh-server-access-token");
    expect(JSON.stringify(result)).not.toContain("fresh-server-refresh-token");
    expect(protocol.exchanged).toMatchObject({ forceReauthentication: true });
    expect(sessions.replaceTokens).toHaveBeenCalledWith(
      activeSession.id,
      "encrypted-v1",
      protocol.authorization.tokens,
      protocol.authorization.keycloakSid,
    );
  });

  it.each(["/", "/identity", "/security", "/sessions", "/permissions", "/club-profile", "/delete-account"])(
    "round-trips the allowlisted sudo return path %s through the transaction store",
    async (path) => {
      const { flow, protocol } = fixture();
      const started = await flow.beginSudoReauthentication(activeSession, path);
      const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", protocol.proof!.state);
      await expect(flow.callback(callback, started.browserBinding, handle)).resolves.toMatchObject({
        sudoReauthentication: "success",
        returnTo: path,
      });
    },
  );

  it.each([
    ["/admin", "/"],
    ["//attacker.invalid/", "/"],
    ["https://my.yildizskylab.com/permissions", "/"],
    ["/club-profile/edit", "/"],
    // Only the pathname survives: traversal and query/fragment collapse onto the allowlisted page.
    ["/permissions/../security", "/security"],
    ["/security?x=1#f", "/security"],
  ])("normalises the sudo return path %s to %s", async (path, expected) => {
    const { flow, protocol } = fixture();
    const started = await flow.beginSudoReauthentication(activeSession, path);
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", protocol.proof!.state);
    await expect(flow.callback(callback, started.browserBinding, handle)).resolves.toMatchObject({
      returnTo: expected,
    });
  });

  it("normalises the sudo return path and reports a cancelled Microsoft re-authentication", async () => {
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginSudoReauthentication(activeSession, "https://attacker.invalid/phish");
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("state", protocol.proof!.state);
    await expect(flow.callback(callback, started.browserBinding, handle)).resolves.toEqual({
      sudoReauthentication: "cancelled",
      returnTo: "/",
    });
    expect(protocol.exchanged).toBeUndefined();
    expect(sessions.replaceTokens).not.toHaveBeenCalled();
  });

  it("rejects sudo re-authentication bound to another session, subject, or stale auth_time", async () => {
    const missing = fixture();
    const missingStarted = await missing.flow.beginSudoReauthentication(activeSession, "/security");
    const missingCallback = new URL("https://my.yildizskylab.com/api/auth/callback");
    missingCallback.searchParams.set("code", "authorization-code");
    missingCallback.searchParams.set("state", missing.protocol.proof!.state);
    await expect(missing.flow.callback(missingCallback, missingStarted.browserBinding, "x".repeat(43)))
      .rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(missing.protocol.exchanged).toBeUndefined();

    for (const mutate of [
      (protocol: FakeProtocol) => { protocol.authorization.subject = "different-user"; },
      (protocol: FakeProtocol) => { protocol.authorization.authenticatedAt = new Date("2026-09-20T11:50:00Z"); },
      (protocol: FakeProtocol) => { protocol.authorization.keycloakSid = undefined; },
    ]) {
      const current = fixture();
      const started = await current.flow.beginSudoReauthentication(activeSession, "/security");
      mutate(current.protocol);
      const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", current.protocol.proof!.state);
      await expect(current.flow.callback(callback, started.browserBinding, handle))
        .rejects.toBeInstanceOf(InvalidOidcTransactionError);
      expect(current.sessions.replaceTokens).not.toHaveBeenCalled();
    }
  });

  it("keeps demanding a fresh sudo login when Keycloak repeats a Web handoff's old app auth_time", async () => {
    // A Web handoff copies the app's original auth_time onto the Keycloak session;
    // widening that session's lifetime must not make it count as a fresh login.
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginSudoReauthentication(activeSession, "/security");
    protocol.authorization.authenticatedAt = new Date("2026-09-01T09:00:00Z");
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", protocol.proof!.state);

    await expect(flow.callback(callback, started.browserBinding, handle))
      .rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(sessions.replaceTokens).not.toHaveBeenCalled();
  });
});
