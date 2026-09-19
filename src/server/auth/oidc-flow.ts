import "server-only";

import * as oauth from "oauth4webapi";
import { randomOpaqueValue } from "@/server/auth/crypto";
import { OidcContractError, type OidcProtocol } from "@/server/auth/oidc-protocol";
import type { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import type { SessionManager } from "@/server/auth/sessions";
import type { NativeHandoffIdentity } from "@/server/auth/types";

const allowedReturnPaths = new Set([
  "/",
  "/personal-information",
  "/security",
  "/sessions",
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
    private readonly sessions: SessionManager,
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
      { ...proof, returnTo: normalizeReturnTo(returnTo) },
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
        returnTo: "/",
        expectedSubject: identity.subject,
        expectedAuthenticatedAt: identity.authenticatedAt.toISOString(),
      },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  async callback(callbackUrl: URL, browserBinding: string | undefined) {
    const state = callbackUrl.searchParams.get("state");
    if (!state) throw new InvalidOidcTransactionError();
    const transaction = await this.transactions.consume(state, browserBinding);
    if (!transaction) throw new InvalidOidcTransactionError();

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
