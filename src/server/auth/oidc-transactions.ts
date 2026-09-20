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
    ["/", "/personal-information", "/security", "/sessions", "/delete-account"]
      .includes(payload.returnTo)
  );
}

function validIsoDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validTransactionPayload(payload: OidcTransactionPayload) {
  if (!validCoreProof(payload)) return false;
  if (payload.purpose === "account-action") {
    const initiatedAt = new Date(payload.initiatedAt);
    if (
      !payload.expectedSubject ||
      payload.expectedSubject.length > 255 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.expectedSessionId) ||
      !Number.isFinite(initiatedAt.getTime()) ||
      initiatedAt.toISOString() !== payload.initiatedAt ||
      !["password", "otp", "passkey", "delete-credential"].includes(payload.action.kind) ||
      payload.action.beforeCredentials.length > 64
    ) return false;
    const expectedAction = payload.action.kind === "password"
      ? { keycloakAction: "UPDATE_PASSWORD", credentialType: "password", hasCredentialId: false }
      : payload.action.kind === "otp"
        ? { keycloakAction: "CONFIGURE_TOTP", credentialType: "otp", hasCredentialId: false }
        : payload.action.kind === "passkey"
          ? { keycloakAction: "webauthn-register-passwordless", credentialType: "webauthn-passwordless", hasCredentialId: false }
          : {
              keycloakAction: `delete_credential:${payload.action.credentialId ?? ""}`,
              credentialType: payload.action.credentialType,
              hasCredentialId: true,
            };
    if (
      payload.action.keycloakAction !== expectedAction.keycloakAction ||
      payload.action.credentialType !== expectedAction.credentialType ||
      (payload.action.kind === "delete-credential" &&
        payload.action.credentialType !== "otp" &&
        payload.action.credentialType !== "webauthn-passwordless") ||
      (expectedAction.hasCredentialId !== (payload.action.credentialId !== undefined)) ||
      (payload.action.credentialId !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(payload.action.credentialId))
    ) return false;
    const seen = new Set<string>();
    return payload.action.beforeCredentials.every((credential) => {
      if (seen.has(credential.id)) return false;
      seen.add(credential.id);
      return (
        credential.id.length > 0 && credential.id.length <= 255 &&
        credential.type.length > 0 && credential.type.length <= 128 &&
        (credential.createdAt === null || validIsoDate(credential.createdAt))
      );
    });
  }
  if (payload.purpose === "account-deletion-reauthentication") {
    return (
      typeof payload.expectedSubject === "string" &&
      payload.expectedSubject.length > 0 &&
      payload.expectedSubject.length <= 255 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(payload.expectedSessionId) &&
      validIsoDate(payload.initiatedAt)
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
