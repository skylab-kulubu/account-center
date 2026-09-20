import "server-only";

import { randomUUID } from "node:crypto";
import { constantTimeEqual, sha256 } from "@/server/auth/crypto";
import type { SecretCipher } from "@/server/auth/crypto";
import type { OidcTransactionRepository } from "@/server/auth/repositories";
import type { OidcTransactionPayload } from "@/server/auth/types";

export class OidcTransactionStore {
  constructor(
    private readonly repository: OidcTransactionRepository,
    private readonly cipher: SecretCipher,
    private readonly ttlSeconds: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(
    payload: OidcTransactionPayload,
    browserBinding: string,
    maximumTtlSeconds = this.ttlSeconds,
  ) {
    const id = randomUUID();
    const now = this.clock();
    const ttlSeconds = Math.max(1, Math.min(this.ttlSeconds, maximumTtlSeconds));
    await this.repository.insert({
      id,
      stateHash: sha256(payload.state),
      browserBindingHash: sha256(browserBinding),
      payloadCiphertext: this.cipher.encrypt(
        { ...payload, browserBindingHash: sha256(browserBinding).toString("base64url") },
        `oidc-transaction:${id}`,
      ),
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
    });
  }

  async consume(state: string, browserBinding: string | undefined) {
    if (
      !/^[A-Za-z0-9_-]{32,256}$/.test(state) ||
      !browserBinding ||
      !/^[A-Za-z0-9_-]{43}$/.test(browserBinding)
    ) return null;
    const stored = await this.repository.consume(
      sha256(state),
      sha256(browserBinding),
      this.clock(),
    );
    if (!stored) return null;

    const payload = this.cipher.decrypt<OidcTransactionPayload & { browserBindingHash: string }>(
      stored.payloadCiphertext,
      `oidc-transaction:${stored.id}`,
    );
    if (
      !constantTimeEqual(payload.state, state) ||
      !constantTimeEqual(
        payload.browserBindingHash,
        sha256(browserBinding).toString("base64url"),
      )
    ) return null;
    const hasExpectedSubject = payload.expectedSubject !== undefined;
    const hasExpectedAuthenticationTime = payload.expectedAuthenticatedAt !== undefined;
    if (hasExpectedSubject !== hasExpectedAuthenticationTime) return null;
    if (hasExpectedSubject) {
      const expectedTime = new Date(payload.expectedAuthenticatedAt!);
      if (
        typeof payload.expectedSubject !== "string" ||
        payload.expectedSubject.length === 0 ||
        payload.expectedSubject.length > 255 ||
        !Number.isFinite(expectedTime.getTime()) ||
        expectedTime.toISOString() !== payload.expectedAuthenticatedAt
      ) return null;
    }
    return {
      state: payload.state,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
      returnTo: payload.returnTo,
      ...(hasExpectedSubject
        ? {
            expectedSubject: payload.expectedSubject,
            expectedAuthenticatedAt: payload.expectedAuthenticatedAt,
          }
        : {}),
    };
  }
}
