import { describe, expect, it } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import { InvalidOidcTransactionError, OidcFlowService } from "@/server/auth/oidc-flow";
import type {
  AuthorizationResult,
  BeginAuthorizationInput,
  ExchangeAuthorizationInput,
  OidcProtocol,
} from "@/server/auth/oidc-protocol";
import type { OidcTransactionRepository, SessionRepository } from "@/server/auth/repositories";
import { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import { SessionManager } from "@/server/auth/sessions";
import type { NewSessionRecord, SessionUseResult, StoredOidcTransaction } from "@/server/auth/types";

class MemoryTransactions implements OidcTransactionRepository {
  rows = new Map<string, StoredOidcTransaction & { consumed?: boolean }>();
  async insert(value: StoredOidcTransaction) {
    this.rows.set(value.stateHash.toString("hex"), value);
  }
  async consume(stateHash: Buffer, browserBindingHash: Buffer, now: Date) {
    const row = this.rows.get(stateHash.toString("hex"));
    if (!row || !row.browserBindingHash.equals(browserBindingHash) || row.consumed || row.expiresAt <= now) return null;
    row.consumed = true;
    return { id: row.id, payloadCiphertext: row.payloadCiphertext };
  }
}

class CapturingSessions implements SessionRepository {
  inserted?: NewSessionRecord;
  async insert(value: NewSessionRecord) { this.inserted = value; }
  async useHandle(): Promise<SessionUseResult | null> { return null; }
  async revokeByHandle() { return false; }
  async getTokenCiphertext() { return null; }
  async replaceTokenCiphertext() { return false; }
  async revokeById() { return false; }
  async deleteByIdReturningToken() { return null; }
}

class FakeProtocol implements OidcProtocol {
  proof?: BeginAuthorizationInput;
  exchanged?: ExchangeAuthorizationInput;
  rejectExchange = false;

  async begin(input: BeginAuthorizationInput) {
    this.proof = input;
    return { authorizationUrl: new URL("https://e.yildizskylab.com/authorize?request_uri=urn%3Apar%3A1"), expiresIn: 90 };
  }

  async exchange(input: ExchangeAuthorizationInput): Promise<AuthorizationResult> {
    this.exchanged = input;
    if (
      this.rejectExchange ||
      input.nonce !== this.proof?.nonce ||
      input.codeVerifier !== this.proof.codeVerifier
    ) {
      throw new Error("nonce or PKCE validation failed");
    }
    return {
      subject: "user-id",
      keycloakSid: "keycloak-session",
      authenticatedAt: new Date(),
      tokens: { accessToken: "access", idToken: "id", tokenType: "bearer" },
    };
  }

  async revokeRefreshToken() {}
  async refresh(): Promise<never> { throw new Error("not used"); }
}

function fixture() {
  const repository = new CapturingSessions();
  const protocol = new FakeProtocol();
  const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 5));
  const transactions = new OidcTransactionStore(new MemoryTransactions(), cipher, 300);
  const sessions = new SessionManager(
    repository,
    cipher,
    Buffer.alloc(32, 6),
    { absoluteTtlSeconds: 3600, upstreamSessionMaxSeconds: 3600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
  );
  return { flow: new OidcFlowService(protocol, transactions, sessions), protocol, repository };
}

describe("OidcFlowService", () => {
  it("binds state, nonce and PKCE to a one-time server transaction", async () => {
    const { flow, protocol, repository } = fixture();
    const started = await flow.begin("/security");
    expect(protocol.proof?.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(protocol.proof?.nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(protocol.proof?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const callback = new URL("https://my.yildizskylab.com/api/auth/callback");
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", protocol.proof!.state);
    await expect(flow.callback(callback, "x".repeat(43))).rejects.toBeInstanceOf(InvalidOidcTransactionError);
    const result = await flow.callback(callback, started.browserBinding);

    expect(protocol.exchanged).toMatchObject(protocol.proof!);
    expect(repository.inserted?.subject).toBe("user-id");
    expect(result.returnTo).toBe("/security");
    await expect(flow.callback(callback, started.browserBinding)).rejects.toBeInstanceOf(InvalidOidcTransactionError);
  });

  it("rejects unknown state before code exchange", async () => {
    const { flow, protocol } = fixture();
    const started = await flow.begin("/");
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x&state=invalid-state-that-is-long-enough-1234567890");
    await expect(flow.callback(callback, started.browserBinding)).rejects.toBeInstanceOf(InvalidOidcTransactionError);
    expect(protocol.exchanged).toBeUndefined();
  });

  it("does not create a session when nonce or PKCE validation fails", async () => {
    const { flow, protocol, repository } = fixture();
    const started = await flow.begin("/");
    protocol.rejectExchange = true;
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    callback.searchParams.set("state", protocol.proof!.state);
    await expect(flow.callback(callback, started.browserBinding)).rejects.toThrow(/nonce or PKCE/);
    expect(repository.inserted).toBeUndefined();
  });
});
