// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import {
  InvalidAccountActionError,
  InvalidOidcTransactionError,
  OidcFlowService,
} from "@/server/auth/oidc-flow";
import type {
  AuthorizationResult,
  BeginAuthorizationInput,
  ExchangeAuthorizationInput,
  OidcProtocol,
} from "@/server/auth/oidc-protocol";
import type { OidcTransactionRepository } from "@/server/auth/repositories";
import { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import type { ActiveSession, StoredOidcTransaction } from "@/server/auth/types";
import type { CredentialInventory } from "@/server/keycloak-account/types";

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

function inventory(credentials: CredentialInventory["credentials"]): CredentialInventory {
  return {
    summary: {
      passwordConfigured: credentials.some(({ type }) => type === "password"),
      otpConfigured: credentials.some(({ type }) => type === "otp" || type === "totp"),
      passkeyCount: credentials.filter(({ type }) => type === "webauthn-passwordless").length,
    },
    credentials,
  };
}

const password = {
  id: "password-owned-id",
  type: "password",
  label: "Şifre",
  createdAt: "2026-09-01T00:00:00.000Z",
  removeable: false,
};
const passkey = {
  id: "passkey-owned-id",
  type: "webauthn-passwordless",
  label: "MacBook Touch ID",
  createdAt: "2026-09-02T00:00:00.000Z",
  removeable: true,
};

function fixture() {
  const protocol = new FakeProtocol();
  let before = inventory([password, passkey]);
  let after = before;
  const reference = (credentialId: string) => createHash("sha256")
    .update(`${activeSession.id}\0${credentialId}`)
    .digest("base64url");
  const sessions = {
    candidate: vi.fn(async (candidate: string | undefined) => candidate === handle ? activeSession : null),
    authenticate: vi.fn(async (candidate: string | undefined) => candidate === handle
      ? { session: activeSession, rotated: false }
      : null),
    create: vi.fn(),
    credentialReference: vi.fn((sessionId: string, credentialId: string) => {
      expect(sessionId).toBe(activeSession.id);
      return reference(credentialId);
    }),
    readTokens: vi.fn(async () => ({
      tokens: { accessToken: "old", idToken: "old", tokenType: "bearer" },
      version: "encrypted-v1",
    })),
    replaceTokens: vi.fn(async () => true),
  };
  const accountAccess = { requireActive: vi.fn(async () => undefined) };
  const account = { credentialInventory: vi.fn(async () => before) };
  const adapter = { credentialInventory: vi.fn(async () => after) };
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
    account,
    adapter,
    () => now,
  );
  return {
    flow,
    protocol,
    sessions,
    accountAccess,
    reference,
    setBefore(value: CredentialInventory) { before = value; },
    setAfter(value: CredentialInventory) { after = value; },
  };
}

function callbackUrl(protocol: FakeProtocol, status: "success" | "cancelled", action: string) {
  const url = new URL("https://my.yildizskylab.com/api/auth/callback");
  url.searchParams.set("code", "authorization-code");
  url.searchParams.set("state", protocol.proof!.state);
  url.searchParams.set("kc_action", action);
  url.searchParams.set("kc_action_status", status);
  return url;
}

describe("Account Center application-initiated actions", () => {
  it.each([
    ["password", "UPDATE_PASSWORD"],
    ["otp", "CONFIGURE_TOTP"],
    ["passkey", "webauthn-register-passwordless"],
  ] as const)("starts only the allowlisted %s action with forced fresh authentication", async (kind, expected) => {
    const { flow, protocol } = fixture();
    const started = await flow.beginAccountAction({ kind }, activeSession);

    expect(protocol.proof).toMatchObject({
      accountAction: expected,
      forceReauthentication: true,
    });
    expect(started.authorizationUrl.searchParams.get("request_uri")).toBe("urn:par:action");
    expect(started.authorizationUrl.href).not.toContain(expected);
    expect(started.authorizationUrl.href).not.toContain(activeSession.subject);
  });

  it("resolves a deletion capability against a freshly-read owned credential", async () => {
    const { flow, protocol, reference } = fixture();
    const started = await flow.beginAccountAction({
      kind: "delete-credential",
      deletionReference: reference(passkey.id),
    }, activeSession);

    expect(protocol.proof?.accountAction).toBe(`delete_credential:${passkey.id}`);
    expect(started.authorizationUrl.href).not.toContain(passkey.id);

    const other = fixture();
    await expect(other.flow.beginAccountAction({
      kind: "delete-credential",
      deletionReference: other.reference("somebody-elses-credential"),
    }, activeSession)).rejects.toBeInstanceOf(InvalidAccountActionError);
    expect(other.protocol.proof).toBeUndefined();
  });

  it("does not trust kc_action_status=success without a fresh inventory delta", async () => {
    const { flow, protocol, sessions } = fixture();
    const started = await flow.beginAccountAction({ kind: "passkey" }, activeSession);
    const result = await flow.callback(
      callbackUrl(protocol, "success", "webauthn-register-passwordless"),
      started.browserBinding,
      handle,
    );

    expect(result).toMatchObject({ actionOutcome: "unverified", action: "passkey" });
    expect(sessions.replaceTokens).toHaveBeenCalledWith(
      activeSession.id,
      "encrypted-v1",
      protocol.authorization.tokens,
      protocol.authorization.keycloakSid,
    );
  });

  it("accepts success only after a fresh subject-bound callback and observable state change", async () => {
    const { flow, protocol, sessions, setAfter } = fixture();
    protocol.authorization.keycloakSid = "fresh-keycloak-session";
    setAfter(inventory([password, passkey, {
      id: "new-passkey-id",
      type: "webauthn-passwordless",
      label: "Telefon",
      createdAt: "2026-09-20T12:00:00.000Z",
      removeable: true,
    }]));
    const started = await flow.beginAccountAction({ kind: "passkey" }, activeSession);
    const result = await flow.callback(
      callbackUrl(protocol, "success", "webauthn-register-passwordless"),
      started.browserBinding,
      handle,
    );

    expect(result).toMatchObject({ actionOutcome: "success", action: "passkey" });
    expect(sessions.replaceTokens).toHaveBeenCalledWith(
      activeSession.id,
      "encrypted-v1",
      protocol.authorization.tokens,
      "fresh-keycloak-session",
    );
  });

  it("verifies exact deletion and rejects a forged returned action", async () => {
    const { flow, protocol, reference, setAfter } = fixture();
    setAfter(inventory([password]));
    const started = await flow.beginAccountAction({
      kind: "delete-credential",
      deletionReference: reference(passkey.id),
    }, activeSession);
    await expect(flow.callback(
      callbackUrl(protocol, "success", "delete_credential"),
      started.browserBinding,
      handle,
    )).resolves.toMatchObject({ actionOutcome: "success" });

    const forged = fixture();
    const second = await forged.flow.beginAccountAction({ kind: "password" }, activeSession);
    await expect(forged.flow.callback(
      callbackUrl(forged.protocol, "success", "CONFIGURE_TOTP"),
      second.browserBinding,
      handle,
    )).resolves.toMatchObject({ actionOutcome: "error", action: "password" });
  });

  it("handles cancellation and provider error without accepting them as a change", async () => {
    const cancelled = fixture();
    const started = await cancelled.flow.beginAccountAction({ kind: "otp" }, activeSession);
    await expect(cancelled.flow.callback(
      callbackUrl(cancelled.protocol, "cancelled", "CONFIGURE_TOTP"),
      started.browserBinding,
      handle,
    )).resolves.toMatchObject({ actionOutcome: "cancelled" });
    expect(cancelled.sessions.replaceTokens).toHaveBeenCalledWith(
      activeSession.id,
      "encrypted-v1",
      cancelled.protocol.authorization.tokens,
      cancelled.protocol.authorization.keycloakSid,
    );

    const failed = fixture();
    const failedStarted = await failed.flow.beginAccountAction({ kind: "otp" }, activeSession);
    const errorUrl = new URL("https://my.yildizskylab.com/api/auth/callback");
    errorUrl.searchParams.set("state", failed.protocol.proof!.state);
    errorUrl.searchParams.set("error", "access_denied");
    await expect(failed.flow.callback(errorUrl, failedStarted.browserBinding, handle))
      .resolves.toMatchObject({ actionOutcome: "error" });
    expect(failed.protocol.exchanged).toBeUndefined();
    expect(failed.sessions.replaceTokens).not.toHaveBeenCalled();
  });

  it("binds callback to the original BFF session, subject, and fresh auth_time", async () => {
    const missingSession = fixture();
    const started = await missingSession.flow.beginAccountAction({ kind: "password" }, activeSession);
    await expect(missingSession.flow.callback(
      callbackUrl(missingSession.protocol, "success", "UPDATE_PASSWORD"),
      started.browserBinding,
      "x".repeat(43),
    )).rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(missingSession.protocol.exchanged).toBeUndefined();

    const wrongSubject = fixture();
    const wrongStarted = await wrongSubject.flow.beginAccountAction({ kind: "password" }, activeSession);
    wrongSubject.protocol.authorization.subject = "different-user";
    await expect(wrongSubject.flow.callback(
      callbackUrl(wrongSubject.protocol, "success", "UPDATE_PASSWORD"),
      wrongStarted.browserBinding,
      handle,
    )).resolves.toMatchObject({ actionOutcome: "error", action: "password" });
    expect(wrongSubject.sessions.replaceTokens).not.toHaveBeenCalled();

    const stale = fixture();
    const staleStarted = await stale.flow.beginAccountAction({ kind: "password" }, activeSession);
    stale.protocol.authorization.authenticatedAt = new Date("2026-09-20T11:50:00.000Z");
    await expect(stale.flow.callback(
      callbackUrl(stale.protocol, "success", "UPDATE_PASSWORD"),
      staleStarted.browserBinding,
      handle,
    )).resolves.toMatchObject({ actionOutcome: "error", action: "password" });
    expect(stale.sessions.replaceTokens).not.toHaveBeenCalled();

    const missingSid = fixture();
    const missingSidStarted = await missingSid.flow.beginAccountAction({ kind: "password" }, activeSession);
    missingSid.protocol.authorization.keycloakSid = undefined;
    await expect(missingSid.flow.callback(
      callbackUrl(missingSid.protocol, "success", "UPDATE_PASSWORD"),
      missingSidStarted.browserBinding,
      handle,
    )).resolves.toMatchObject({ actionOutcome: "error", action: "password" });
    expect(missingSid.sessions.replaceTokens).not.toHaveBeenCalled();
  });
});
