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
import { AccountAccessBlockedError } from "@/server/access-gate/authorization";

const now = new Date("2026-09-22T09:00:00.000Z");
const handle = "h".repeat(43);
const activeSession: ActiveSession = {
  id: "d9a9bb4a-4977-4f07-8eb7-d3ba5c45e5cd",
  subject: "user-id",
  keycloakSid: "keycloak-session",
  createdAt: new Date("2026-09-22T08:00:00.000Z"),
  lastSeenAt: new Date("2026-09-22T08:59:00.000Z"),
  idleExpiresAt: new Date("2026-09-22T09:30:00.000Z"),
  absoluteExpiresAt: new Date("2026-09-22T16:00:00.000Z"),
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
  rejectExchange = false;
  authorization: AuthorizationResult = {
    subject: activeSession.subject,
    keycloakSid: "rotated-keycloak-session",
    // Linking does not force a login: the SSO authentication may predate the transaction.
    authenticatedAt: new Date("2026-09-22T08:00:00.000Z"),
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
      authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3Aytu-link"),
      expiresIn: 90,
    };
  }

  async exchange(input: ExchangeAuthorizationInput) {
    this.exchanged = input;
    if (this.rejectExchange) throw new Error("token endpoint refused the code");
    return this.authorization;
  }

  async refresh(): Promise<never> { throw new Error("not used"); }
  async revokeRefreshToken() {}
}

function fixture(decision: "active" | "blocked" = "active") {
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
  const accountAccess = {
    requireActive: vi.fn(async () => {
      if (decision === "blocked") throw new AccountAccessBlockedError();
    }),
  };
  const flow = new OidcFlowService(
    protocol,
    new OidcTransactionStore(
      new MemoryTransactions(),
      new AesGcmSecretCipher(Buffer.alloc(32, 7)),
      300,
      () => now,
    ),
    sessions,
    accountAccess,
    { ytuIdpAlias: "OBS", clock: () => now },
  );
  return { flow, protocol, sessions, accountAccess };
}

function callbackFor(state: string, parameters: Record<string, string>) {
  const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
  callback.searchParams.set("state", state);
  for (const [name, value] of Object.entries(parameters)) callback.searchParams.set(name, value);
  return callback;
}

const linked = { code: "authorization-code", kc_action: "idp_link", kc_action_status: "success" };

describe("YTÜ account link (kc_action=idp_link)", () => {
  it("starts the idp_link action for the configured alias without a forced login and binds it to the session", async () => {
    const { flow, protocol } = fixture();
    const started = await flow.beginYtuLink(activeSession);
    expect(protocol.proof).toMatchObject({ accountAction: { action: "idp_link", parameter: "OBS" } });
    expect(Object.keys(protocol.proof!).sort()).toEqual(["accountAction", "codeVerifier", "nonce", "state"]);
    expect(started.authorizationUrl.href).not.toContain(activeSession.subject);
    expect(started.authorizationUrl.href).not.toContain("kc_action");
    expect(started.browserBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("uses the deployment's own alias", async () => {
    const protocol = new FakeProtocol();
    const flow = new OidcFlowService(
      protocol,
      new OidcTransactionStore(new MemoryTransactions(), new AesGcmSecretCipher(Buffer.alloc(32, 8)), 300, () => now),
      fixture().sessions,
      { requireActive: vi.fn(async () => undefined) },
      { ytuIdpAlias: "obs-sandbox" },
    );
    await flow.beginYtuLink(activeSession);
    expect(protocol.proof?.accountAction).toEqual({ action: "idp_link", parameter: "obs-sandbox" });
  });

  it("exchanges a successful return, accepts the rotated sid and keeps the fresh token set on the same session", async () => {
    const { flow, protocol, sessions, accountAccess } = fixture();
    const started = await flow.beginYtuLink(activeSession);
    const result = await flow.callback(callbackFor(protocol.proof!.state, linked), started.browserBinding, handle);

    expect(result).toEqual({ ytuLink: "success", session: activeSession, returnTo: "/identity" });
    expect(JSON.stringify(result)).not.toContain("fresh-server");
    expect(protocol.exchanged).toMatchObject({
      state: protocol.proof!.state,
      nonce: protocol.proof!.nonce,
      codeVerifier: protocol.proof!.codeVerifier,
    });
    expect(protocol.exchanged).not.toHaveProperty("forceReauthentication");
    expect(accountAccess.requireActive).toHaveBeenCalledWith(activeSession.subject);
    expect(sessions.replaceTokens).toHaveBeenCalledWith(
      activeSession.id,
      "encrypted-v1",
      protocol.authorization.tokens,
      "rotated-keycloak-session",
    );
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "error"] as const)("reports a %s action after still exchanging the code", async (status) => {
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginYtuLink(activeSession);
    const result = await flow.callback(
      callbackFor(protocol.proof!.state, { ...linked, kc_action_status: status }),
      started.browserBinding,
      handle,
    );
    expect(result).toEqual({ ytuLink: status, session: activeSession, returnTo: "/identity" });
    expect(protocol.exchanged).toBeDefined();
    expect(sessions.replaceTokens).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an OAuth error instead of a code", { error: "access_denied" }],
    ["no action at all", { code: "authorization-code" }],
    ["a different action", { code: "authorization-code", kc_action: "UPDATE_PASSWORD", kc_action_status: "success" }],
    ["a forged status", { ...linked, kc_action_status: "linked" }],
    ["an action without a status", { code: "authorization-code", kc_action: "idp_link" }],
  ])("treats %s as an error without touching the code or the session", async (_case, parameters) => {
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginYtuLink(activeSession);
    const result = await flow.callback(callbackFor(protocol.proof!.state, parameters), started.browserBinding, handle);
    expect(result).toEqual({ ytuLink: "error", session: activeSession, returnTo: "/identity" });
    expect(protocol.exchanged).toBeUndefined();
    expect(sessions.replaceTokens).not.toHaveBeenCalled();
  });

  it("reports an error when the code cannot be exchanged and stores nothing", async () => {
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginYtuLink(activeSession);
    protocol.rejectExchange = true;
    const result = await flow.callback(callbackFor(protocol.proof!.state, linked), started.browserBinding, handle);
    expect(result).toEqual({ ytuLink: "error", session: activeSession, returnTo: "/identity" });
    expect(sessions.replaceTokens).not.toHaveBeenCalled();
  });

  it("rejects a return for another person, without a Keycloak sid, or from another browser or session", async () => {
    for (const mutate of [
      (protocol: FakeProtocol) => { protocol.authorization.subject = "different-user"; },
      (protocol: FakeProtocol) => { protocol.authorization.keycloakSid = undefined; },
    ]) {
      const current = fixture();
      const started = await current.flow.beginYtuLink(activeSession);
      mutate(current.protocol);
      await expect(current.flow.callback(callbackFor(current.protocol.proof!.state, linked), started.browserBinding, handle))
        .rejects.toBeInstanceOf(InvalidOidcTransactionError);
      expect(current.sessions.replaceTokens).not.toHaveBeenCalled();
    }

    const foreignBrowser = fixture();
    await foreignBrowser.flow.beginYtuLink(activeSession);
    await expect(foreignBrowser.flow.callback(callbackFor(foreignBrowser.protocol.proof!.state, linked), "x".repeat(43), handle))
      .rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(foreignBrowser.protocol.exchanged).toBeUndefined();

    const otherSession = fixture();
    const otherStarted = await otherSession.flow.beginYtuLink(activeSession);
    await expect(otherSession.flow.callback(callbackFor(otherSession.protocol.proof!.state, linked), otherStarted.browserBinding, "y".repeat(43)))
      .rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(otherSession.protocol.exchanged).toBeUndefined();

    const otherPerson = fixture();
    const otherPersonStarted = await otherPerson.flow.beginYtuLink({ ...activeSession, subject: "someone-else" });
    await expect(otherPerson.flow.callback(callbackFor(otherPerson.protocol.proof!.state, linked), otherPersonStarted.browserBinding, handle))
      .rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(otherPerson.protocol.exchanged).toBeUndefined();
  });

  it("consumes the transaction exactly once", async () => {
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginYtuLink(activeSession);
    const callback = callbackFor(protocol.proof!.state, linked);
    await expect(flow.callback(callback, started.browserBinding, handle)).resolves.toMatchObject({ ytuLink: "success" });
    await expect(flow.callback(callback, started.browserBinding, handle)).rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(sessions.replaceTokens).toHaveBeenCalledTimes(1);
  });

  it("does not store tokens for a person the access gate blocks", async () => {
    const { flow, protocol, sessions } = fixture("blocked");
    const started = await flow.beginYtuLink(activeSession);
    await expect(flow.callback(callbackFor(protocol.proof!.state, linked), started.browserBinding, handle))
      .rejects.toBeInstanceOf(AccountAccessBlockedError);
    expect(sessions.replaceTokens).not.toHaveBeenCalled();
  });
});
