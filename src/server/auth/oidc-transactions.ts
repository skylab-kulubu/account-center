import "server-only";

import { randomUUID } from "node:crypto";
import { constantTimeEqual, sha256 } from "@/server/auth/crypto";
import type { SecretCipher } from "@/server/auth/crypto";
import type { OidcTransactionRepository } from "@/server/auth/repositories";
import type { OidcTransactionPayload } from "@/server/auth/types";

function validCoreProof(payload: OidcTransactionPayload) {
  return (
    /^[A-Za-z0-9_-]{32,256}$/.test(payload.state) &&
    /^[A-Za-z0-9_-]{32,256}$/.test(payload.nonce) &&
    /^[A-Za-z0-9._~-]{43,128}$/.test(payload.codeVerifier) &&
    ["/", "/identity", "/email", "/security", "/sessions", "/permissions", "/club-profile", "/delete-account"]
      .includes(payload.returnTo)
  );
}

function validIsoDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validTransactionPayload(payload: OidcTransactionPayload) {
  if (!validCoreProof(payload)) return false;
  if (
    payload.purpose === "sudo-reauthentication" ||
    payload.purpose === "ytu-link"
  ) {
    return (
      typeof payload.expectedSubject === "string" &&
      payload.expectedSubject.length > 0 &&
      payload.expectedSubject.length <= 255 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(payload.expectedSessionId) &&
      validIsoDate(payload.initiatedAt) &&
      // The YTÜ link always lands on the identity page; no other return path is stored.
      (payload.purpose !== "ytu-link" || payload.returnTo === "/identity")
    );
  }
  if (payload.purpose !== undefined && payload.purpose !== "login") return false;
  const hasExpectedSubject = payload.expectedSubject !== undefined;
  const hasExpectedAuthenticationTime = payload.expectedAuthenticatedAt !== undefined;
  if (hasExpectedSubject !== hasExpectedAuthenticationTime) return false;
  if (!hasExpectedSubject) return true;
  const expectedTime = new Date(payload.expectedAuthenticatedAt!);
  return (
    typeof payload.expectedSubject === "string" &&
    payload.expectedSubject.length > 0 &&
    payload.expectedSubject.length <= 255 &&
    Number.isFinite(expectedTime.getTime()) &&
    expectedTime.toISOString() === payload.expectedAuthenticatedAt
  );
}

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
    const { browserBindingHash: _browserBindingHash, ...transaction } = payload;
    void _browserBindingHash;
    if (!validTransactionPayload(transaction)) return null;
    return transaction;
  }
}
