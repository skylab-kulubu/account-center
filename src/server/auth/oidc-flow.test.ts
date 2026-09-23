import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import { accountRoutes } from "@/config/account-routes";
import { InvalidOidcTransactionError, normalizeReturnTo, OidcFlowService } from "@/server/auth/oidc-flow";
import type {
  AuthorizationResult,
  BeginAuthorizationInput,
  ExchangeAuthorizationInput,
  OidcProtocol,
} from "@/server/auth/oidc-protocol";
import type { OidcTransactionRepository, SessionRepository } from "@/server/auth/repositories";
import { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import { SessionManager, UpstreamSessionExpiredError } from "@/server/auth/sessions";
import type { NewSessionRecord, SessionUseResult, StoredOidcTransaction } from "@/server/auth/types";
import {
  AccountAccessAuthorizer,
  AccountAccessBlockedError,
  AccountAccessUnavailableError,
} from "@/server/access-gate/authorization";
import { logAuthEvent } from "@/server/auth/logging";

vi.mock("@/server/auth/logging", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/auth/logging")>(),
  logAuthEvent: vi.fn(),
}));

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
  async findByHandle() { return null; }
  async useHandle(): Promise<SessionUseResult | null> { return null; }
  async revokeByHandle() { return false; }
  async revokeBySubject() { return 0; }
  async revokeSubjectBySessionId() { return 0; }
  async getTokenCiphertext() { return null; }
  async replaceTokenCiphertext() { return false; }
  async revokeById() { return false; }
  async deleteByIdReturningToken() { return null; }
}

class FakeProtocol implements OidcProtocol {
  proof?: BeginAuthorizationInput;
  exchanged?: ExchangeAuthorizationInput;
  rejectExchange = false;
  authorization: AuthorizationResult = {
    subject: "user-id",
    keycloakSid: "keycloak-session",
    authenticatedAt: new Date(),
    tokens: { accessToken: "access", idToken: "id", tokenType: "bearer" },
  };

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
    return this.authorization;
  }

  async revokeRefreshToken() {}
  async refresh(): Promise<never> { throw new Error("not used"); }
}

function fixture(
  decision: "active" | "blocked" | "unavailable" = "active",
  lifetimes = { absoluteTtlSeconds: 3600, upstreamSessionMaxSeconds: 3600 },
) {
  const repository = new CapturingSessions();
  const protocol = new FakeProtocol();
  const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 5));
  const transactions = new OidcTransactionStore(new MemoryTransactions(), cipher, 300);
  const sessions = new SessionManager(
    repository,
    cipher,
    Buffer.alloc(32, 6),
    { ...lifetimes, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
  );
  const accountAccess = new AccountAccessAuthorizer(
    { decide: async () => decision, ready: async () => true },
    sessions,
  );
  return {
    flow: new OidcFlowService(protocol, transactions, sessions, accountAccess, { ytuIdpAlias: "OBS" }),
    protocol,
    repository,
  };
}

describe("normalizeReturnTo", () => {
  it("accepts every account page a login or a Sudo mode re-authentication may return to, and nothing else", () => {
    for (const { href } of accountRoutes) {
      expect(normalizeReturnTo(href)).toBe(href);
    }
    expect(normalizeReturnTo("/email")).toBe("/email");
    expect(normalizeReturnTo("/email?x=1#y")).toBe("/email");
    for (const rejected of ["/admin", "/emails", "https://attacker.invalid/email", "//attacker.invalid/email", "", null, undefined]) {
      expect(normalizeReturnTo(rejected)).toBe("/");
    }
  });
});

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

  it.each([
    ["blocked", AccountAccessBlockedError],
    ["unavailable", AccountAccessUnavailableError],
  ] as const)("does not create a session when verified access is %s", async (decision, errorType) => {
    const { flow, protocol, repository } = fixture(decision);
    const started = await flow.begin("/");
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    callback.searchParams.set("state", protocol.proof!.state);

    await expect(flow.callback(callback, started.browserBinding)).rejects.toBeInstanceOf(errorType);
    expect(repository.inserted).toBeUndefined();
  });

  it("binds a native PAR bridge to the expected subject and original authentication time", async () => {
    const { flow, protocol, repository } = fixture();
    const authenticatedAt = new Date(Date.now() - 15 * 60 * 1_000);
    const started = await flow.beginNative(
      { subject: "native-user", keycloakSid: "native-sid", authenticatedAt },
      "bridge-hint",
    );
    expect(protocol.proof).toMatchObject({ nativeBridgeCode: "bridge-hint" });

    const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    callback.searchParams.set("state", protocol.proof!.state);
    protocol.authorization = {
      ...protocol.authorization,
      subject: "other-user",
      authenticatedAt,
    };
    await expect(flow.callback(callback, started.browserBinding)).rejects.toThrow(/native identity/);
    expect(repository.inserted).toBeUndefined();
  });

  it("creates a session only when native callback identity and auth_time both match", async () => {
    const { flow, protocol, repository } = fixture();
    const authenticatedAt = new Date(Date.now() - 15 * 60 * 1_000);
    const started = await flow.beginNative(
      { subject: "native-user", keycloakSid: "native-sid", authenticatedAt },
      "bridge-hint",
    );
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    callback.searchParams.set("state", protocol.proof!.state);
    protocol.authorization = {
      ...protocol.authorization,
      subject: "native-user",
      authenticatedAt: new Date(authenticatedAt.getTime() + 1_000),
    };
    await expect(flow.callback(callback, started.browserBinding)).rejects.toThrow(/authentication time/);
    expect(repository.inserted).toBeUndefined();

    const retry = await flow.beginNative(
      { subject: "native-user", keycloakSid: "native-sid", authenticatedAt },
      "bridge-hint-2",
    );
    callback.searchParams.set("state", protocol.proof!.state);
    protocol.authorization.authenticatedAt = authenticatedAt;
    await expect(flow.callback(callback, retry.browserBinding)).resolves.toMatchObject({
      returnTo: "/",
    });
    expect(repository.inserted?.subject).toBe("native-user");
  });

  it("opens a native bridge session even when the app logged in longer ago than the upstream session max", async () => {
    const { flow, protocol, repository } = fixture();
    const appLogin = new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000);
    const started = await flow.beginNative(
      { subject: "native-user", keycloakSid: "native-sid", authenticatedAt: appLogin },
      "bridge-hint",
    );
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    callback.searchParams.set("state", protocol.proof!.state);
    protocol.authorization = { ...protocol.authorization, subject: "native-user", authenticatedAt: appLogin };

    const before = Date.now();
    await expect(flow.callback(callback, started.browserBinding)).resolves.toMatchObject({ returnTo: "/" });
    expect(repository.inserted?.subject).toBe("native-user");
    expect(repository.inserted!.absoluteExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it("still refuses a plain login whose auth_time is older than the upstream session max", async () => {
    const { flow, protocol, repository } = fixture();
    const started = await flow.begin("/");
    const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    callback.searchParams.set("state", protocol.proof!.state);
    protocol.authorization = {
      ...protocol.authorization,
      authenticatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000),
    };

    await expect(flow.callback(callback, started.browserBinding)).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
    expect(repository.inserted).toBeUndefined();
  });

  describe("with Keycloak's session claims", () => {
    const eightHours = { absoluteTtlSeconds: 8 * 60 * 60, upstreamSessionMaxSeconds: 8 * 60 * 60 };

    async function login(
      authorization: Partial<AuthorizationResult>,
      options: { native?: boolean; requestId?: string } = {},
    ) {
      const current = fixture("active", eightHours);
      current.protocol.authorization = { ...current.protocol.authorization, ...authorization };
      const started = options.native
        ? await current.flow.beginNative(
          {
            subject: current.protocol.authorization.subject,
            keycloakSid: "native-sid",
            authenticatedAt: current.protocol.authorization.authenticatedAt,
          },
          "bridge-hint",
        )
        : await current.flow.begin("/");
      const callback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
      callback.searchParams.set("state", current.protocol.proof!.state);
      return {
        ...current,
        result: current.flow.callback(callback, started.browserBinding, undefined, options.requestId),
      };
    }

    // Every cap is compared exactly, so every Date.now() inside the flow must agree.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-20T12:00:00.250Z") });
      vi.mocked(logAuthEvent).mockClear();
    });
    afterEach(() => vi.useRealTimers());

    it("keeps the cap at auth_time + the upstream max when the ID token has no session claims", async () => {
      const { result, repository } = await login({ authenticatedAt: new Date("2026-09-20T11:30:00Z") });

      await expect(result).resolves.not.toHaveProperty("embeddedApp");
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T19:30:00Z"));
      expect(logAuthEvent).not.toHaveBeenCalled();
    });

    it("opens a remember-me session logged in 20 days ago with the 8-hour local cap", async () => {
      const { result, repository } = await login({
        authenticatedAt: new Date("2026-08-31T12:00:00Z"),
        upstreamSessionStartedAt: new Date("2026-08-31T12:00:00Z"),
        upstreamSessionExpiresAt: new Date("2026-09-30T12:00:00Z"),
      });

      await expect(result).resolves.toMatchObject({ returnTo: "/" });
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T20:00:00.250Z"));
      expect(logAuthEvent).not.toHaveBeenCalled();
    });

    it("prefers Keycloak's session end over the start-based estimate", async () => {
      const { result, repository } = await login({
        authenticatedAt: new Date("2026-08-31T12:00:00Z"),
        upstreamSessionStartedAt: new Date("2026-09-20T11:59:57Z"),
        upstreamSessionExpiresAt: new Date("2026-09-20T12:30:00Z"),
      });

      await result;
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T12:30:00Z"));
    });

    it("refuses a login whose Keycloak session has already ended", async () => {
      // auth_time + 8 h would still be open; Keycloak's own end is what counts.
      const { result, repository } = await login({
        authenticatedAt: new Date("2026-09-20T11:00:00Z"),
        upstreamSessionExpiresAt: new Date("2026-09-20T11:59:59Z"),
      });

      await expect(result).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
      expect(repository.inserted).toBeUndefined();
    });

    it("opens a Web handoff session from an app login older than the upstream max at the Keycloak session start", async () => {
      const { result, repository } = await login({
        authenticatedAt: new Date("2026-08-31T12:00:00Z"),
        upstreamSessionStartedAt: new Date("2026-09-20T11:59:57Z"),
      });

      await expect(result).resolves.toMatchObject({ returnTo: "/" });
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T19:59:57Z"));
    });

    it("falls back to auth_time and logs once, without values, when a session claim was malformed", async () => {
      const { result, repository } = await login({
        authenticatedAt: new Date("2026-09-20T11:30:00Z"),
        sessionClaimIgnored: true,
      }, { requestId: "callback-request" });

      await result;
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T19:30:00Z"));
      expect(logAuthEvent).toHaveBeenCalledTimes(1);
      expect(logAuthEvent).toHaveBeenCalledWith({
        event: "oidc_session_claims",
        requestId: "callback-request",
        outcome: "failure",
        reason: "session_claim_ignored",
      });
    });

    it("still logs the malformed claim when the fallback cap refuses the login", async () => {
      const { result } = await login({
        authenticatedAt: new Date("2026-08-31T12:00:00Z"),
        sessionClaimIgnored: true,
      }, { requestId: "callback-request" });

      await expect(result).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
      expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "session_claim_ignored" }));
    });

    it("starts a native handoff session at the callback when the ID token has no session claims", async () => {
      const { result, repository } = await login({ authenticatedAt: new Date("2026-08-31T12:00:00Z") }, { native: true });

      await expect(result).resolves.toMatchObject({ returnTo: "/", embeddedApp: "skyapp" });
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T20:00:00.250Z"));
    });

    it("lets Keycloak's session end outrank the native handoff's callback start", async () => {
      const { result, repository } = await login({
        authenticatedAt: new Date("2026-08-31T12:00:00Z"),
        upstreamSessionStartedAt: new Date("2026-09-20T11:59:57Z"),
        upstreamSessionExpiresAt: new Date("2026-09-20T14:00:00Z"),
      }, { native: true });

      await result;
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T14:00:00Z"));
    });

    it("keeps the native handoff's callback start over an earlier sky_session_started", async () => {
      const { result, repository } = await login({
        authenticatedAt: new Date("2026-09-20T09:00:00Z"),
        upstreamSessionStartedAt: new Date("2026-09-20T09:00:00Z"),
      }, { native: true });

      await result;
      expect(repository.inserted?.absoluteExpiresAt).toEqual(new Date("2026-09-20T20:00:00.250Z"));
    });
  });

  it("tells the callback which sessions open inside SkyApp: a native handoff or an ID token marked sky_embed", async () => {
    const native = fixture();
    const authenticatedAt = new Date(Date.now() - 15 * 60 * 1_000);
    const started = await native.flow.beginNative(
      { subject: "native-user", keycloakSid: "native-sid", authenticatedAt },
      "bridge-hint",
    );
    const nativeCallback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    nativeCallback.searchParams.set("state", native.protocol.proof!.state);
    native.protocol.authorization = { ...native.protocol.authorization, subject: "native-user", authenticatedAt };
    await expect(native.flow.callback(nativeCallback, started.browserBinding)).resolves.toMatchObject({ embeddedApp: "skyapp" });

    const embedded = fixture();
    const embeddedStarted = await embedded.flow.begin("/");
    const embeddedCallback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    embeddedCallback.searchParams.set("state", embedded.protocol.proof!.state);
    embedded.protocol.authorization = { ...embedded.protocol.authorization, embeddedApp: "skyapp" };
    await expect(embedded.flow.callback(embeddedCallback, embeddedStarted.browserBinding))
      .resolves.toMatchObject({ embeddedApp: "skyapp" });

    const plain = fixture();
    const plainStarted = await plain.flow.begin("/");
    const plainCallback = new URL("https://my.yildizskylab.com/api/auth/callback?code=x");
    plainCallback.searchParams.set("state", plain.protocol.proof!.state);
    const result = await plain.flow.callback(plainCallback, plainStarted.browserBinding);
    expect(result).not.toHaveProperty("embeddedApp");
  });
});
