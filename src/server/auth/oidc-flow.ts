import "server-only";

import * as oauth from "oauth4webapi";
import { randomOpaqueValue } from "@/server/auth/crypto";
import { OidcContractError, type OidcProtocol } from "@/server/auth/oidc-protocol";
import type { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import type { SessionManager } from "@/server/auth/sessions";
import type {
  AccountDeletionReauthenticationTransactionPayload,
  ActiveSession,
  NativeHandoffIdentity,
  SudoReauthenticationTransactionPayload,
} from "@/server/auth/types";
import type { AccountAccessAuthorizer } from "@/server/access-gate/authorization";

/** Account pages a login or a Sudo mode re-authentication may return to; mirrored in `oidc-transactions.ts`. */
const allowedReturnPaths = new Set([
  "/",
  "/personal-information",
  "/security",
  "/sessions",
  "/permissions",
  "/club-profile",
  "/delete-account",
]);

export class InvalidOidcTransactionError extends Error {
  constructor() {
    super("The OIDC transaction is invalid, expired, or already used.");
    this.name = "InvalidOidcTransactionError";
  }
}

export function normalizeReturnTo(value: string | null | undefined) {
  if (!value) return "/";
  try {
    const url = new URL(value, "https://account-center.invalid");
    if (url.origin !== "https://account-center.invalid" || !allowedReturnPaths.has(url.pathname)) return "/";
    return url.pathname;
  } catch {
    return "/";
  }
}

export class OidcFlowService {
  constructor(
    private readonly protocol: OidcProtocol,
    private readonly transactions: OidcTransactionStore,
    private readonly sessions: Pick<
      SessionManager,
      "authenticate" | "candidate" | "create" | "readTokens" | "replaceTokens"
    >,
    private readonly accountAccess: Pick<AccountAccessAuthorizer, "requireActive">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async begin(returnTo?: string | null) {
    const proof = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
    };
    const authorization = await this.protocol.begin(proof);
    const browserBinding = randomOpaqueValue();
    await this.transactions.create(
      { ...proof, purpose: "login", returnTo: normalizeReturnTo(returnTo) },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  async beginNative(identity: NativeHandoffIdentity, bridgeCode: string) {
    const proof = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
      nativeBridgeCode: bridgeCode,
    };
    const authorization = await this.protocol.begin(proof);
    const browserBinding = randomOpaqueValue();
    await this.transactions.create(
      {
        state: proof.state,
        nonce: proof.nonce,
        codeVerifier: proof.codeVerifier,
        purpose: "login",
        returnTo: "/",
        expectedSubject: identity.subject,
        expectedAuthenticatedAt: identity.authenticatedAt.toISOString(),
      },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  async beginAccountDeletionReauthentication(session: ActiveSession) {
    const proof = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
      forceReauthentication: true,
    };
    const authorization = await this.protocol.begin(proof);
    const browserBinding = randomOpaqueValue();
    const initiatedAt = this.clock();
    await this.transactions.create(
      {
        state: proof.state,
        nonce: proof.nonce,
        codeVerifier: proof.codeVerifier,
        purpose: "account-deletion-reauthentication",
        returnTo: "/delete-account",
        expectedSubject: session.subject,
        expectedSessionId: session.id,
        initiatedAt: initiatedAt.toISOString(),
      },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  /**
   * Sudo mode fallback for a person without password, passkey or TOTP: the
   * same forced re-authentication as account deletion, returning to the page
   * that asked for sudo. The callback stores a five-minute proof bound to
   * the signed `auth_time`; no sky-account token exists for this path.
   */
  async beginSudoReauthentication(session: ActiveSession, returnTo?: string | null) {
    const proof = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
      forceReauthentication: true,
    };
    const authorization = await this.protocol.begin(proof);
    const browserBinding = randomOpaqueValue();
    const initiatedAt = this.clock();
    await this.transactions.create(
      {
        state: proof.state,
        nonce: proof.nonce,
        codeVerifier: proof.codeVerifier,
        purpose: "sudo-reauthentication",
        returnTo: normalizeReturnTo(returnTo),
        expectedSubject: session.subject,
        expectedSessionId: session.id,
        initiatedAt: initiatedAt.toISOString(),
      },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  async #boundActionSession(
    transaction:
      | AccountDeletionReauthenticationTransactionPayload
      | SudoReauthenticationTransactionPayload,
    sessionHandle: string | undefined,
  ) {
    const candidate = await this.sessions.candidate(sessionHandle);
    if (
      !candidate ||
      candidate.id !== transaction.expectedSessionId ||
      candidate.subject !== transaction.expectedSubject
    ) throw new InvalidOidcTransactionError();
    await this.accountAccess.requireActive(candidate.subject);
    const active = await this.sessions.authenticate(sessionHandle);
    if (
      !active ||
      active.session.id !== transaction.expectedSessionId ||
      active.session.subject !== transaction.expectedSubject
    ) throw new InvalidOidcTransactionError();
    return active.session;
  }

  async #accountDeletionReauthenticationCallback(
    callbackUrl: URL,
    transaction: AccountDeletionReauthenticationTransactionPayload,
    sessionHandle: string | undefined,
  ) {
    const session = await this.#boundActionSession(transaction, sessionHandle);
    if (callbackUrl.searchParams.has("error")) {
      return {
        deletionReauthentication: "cancelled" as const,
        returnTo: transaction.returnTo,
      };
    }
    let authorization;
    try {
      authorization = await this.protocol.exchange({
        callbackUrl,
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        forceReauthentication: true,
      });
    } catch {
      throw new InvalidOidcTransactionError();
    }
    const initiatedAt = new Date(transaction.initiatedAt);
    if (
      authorization.subject !== transaction.expectedSubject ||
      !authorization.keycloakSid ||
      authorization.authenticatedAt.getTime() < initiatedAt.getTime() - 5_000
    ) {
      throw new InvalidOidcTransactionError();
    }
    await this.accountAccess.requireActive(authorization.subject);
    const currentTokens = await this.sessions.readTokens(session.id);
    if (!currentTokens) throw new InvalidOidcTransactionError();
    await this.sessions.replaceTokens(
      session.id,
      currentTokens.version,
      authorization.tokens,
      authorization.keycloakSid,
    );
    return {
      deletionReauthentication: "success" as const,
      session,
      authenticatedAt: authorization.authenticatedAt,
      freshAccessToken: authorization.tokens.accessToken,
      freshIdToken: authorization.tokens.idToken,
      returnTo: transaction.returnTo,
    };
  }

  async #sudoReauthenticationCallback(
    callbackUrl: URL,
    transaction: SudoReauthenticationTransactionPayload,
    sessionHandle: string | undefined,
  ) {
    const session = await this.#boundActionSession(transaction, sessionHandle);
    if (callbackUrl.searchParams.has("error")) {
      return {
        sudoReauthentication: "cancelled" as const,
        returnTo: transaction.returnTo,
      };
    }
    let authorization;
    try {
      authorization = await this.protocol.exchange({
        callbackUrl,
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        forceReauthentication: true,
      });
    } catch {
      throw new InvalidOidcTransactionError();
    }
    const initiatedAt = new Date(transaction.initiatedAt);
    if (
      authorization.subject !== transaction.expectedSubject ||
      !authorization.keycloakSid ||
      authorization.authenticatedAt.getTime() < initiatedAt.getTime() - 5_000
    ) {
      throw new InvalidOidcTransactionError();
    }
    await this.accountAccess.requireActive(authorization.subject);
    const currentTokens = await this.sessions.readTokens(session.id);
    if (!currentTokens) throw new InvalidOidcTransactionError();
    await this.sessions.replaceTokens(
      session.id,
      currentTokens.version,
      authorization.tokens,
      authorization.keycloakSid,
    );
    return {
      sudoReauthentication: "success" as const,
      session,
      authenticatedAt: authorization.authenticatedAt,
      returnTo: transaction.returnTo,
    };
  }

  async callback(
    callbackUrl: URL,
    browserBinding: string | undefined,
    sessionHandle?: string,
  ) {
    const state = callbackUrl.searchParams.get("state");
    if (!state) throw new InvalidOidcTransactionError();
    const transaction = await this.transactions.consume(state, browserBinding);
    if (!transaction) throw new InvalidOidcTransactionError();

    if (transaction.purpose === "account-deletion-reauthentication") {
      return this.#accountDeletionReauthenticationCallback(callbackUrl, transaction, sessionHandle);
    }
    if (transaction.purpose === "sudo-reauthentication") {
      return this.#sudoReauthenticationCallback(callbackUrl, transaction, sessionHandle);
    }

    const authorization = await this.protocol.exchange({
      callbackUrl,
      state: transaction.state,
      nonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier,
    });
    if (
      transaction.expectedSubject !== undefined &&
      authorization.subject !== transaction.expectedSubject
    ) {
      throw new OidcContractError("OIDC callback does not match the expected native identity.");
    }
    if (transaction.expectedAuthenticatedAt !== undefined) {
      const expected = new Date(transaction.expectedAuthenticatedAt);
      if (
        !Number.isFinite(expected.getTime()) ||
        authorization.authenticatedAt.getTime() !== expected.getTime()
      ) {
        throw new OidcContractError("OIDC callback changed the native authentication time.");
      }
    }
    await this.accountAccess.requireActive(authorization.subject);
    const session = await this.sessions.create({
      subject: authorization.subject,
      keycloakSid: authorization.keycloakSid,
      authenticatedAt: authorization.authenticatedAt,
      tokens: authorization.tokens,
    });
    return { ...session, returnTo: transaction.returnTo };
  }

  revokeRefreshToken(refreshToken: string) {
    return this.protocol.revokeRefreshToken(refreshToken);
  }
}
