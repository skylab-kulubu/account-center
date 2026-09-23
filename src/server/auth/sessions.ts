import "server-only";

import { randomUUID } from "node:crypto";
import {
  constantTimeEqual,
  hmacSha256,
  randomOpaqueValue,
  sessionCsrfToken,
  sha256,
  upstreamSessionReference,
} from "@/server/auth/crypto";
import type { SecretCipher } from "@/server/auth/crypto";
import type { SessionRepository } from "@/server/auth/repositories";
import type { BrowserSession, OidcTokenSet } from "@/server/auth/types";
import type { ActiveSession } from "@/server/auth/types";

type SessionPolicy = {
  absoluteTtlSeconds: number;
  upstreamSessionMaxSeconds: number;
  idleTtlSeconds: number;
  rotationSeconds: number;
  previousHandleGraceSeconds: number;
};

export class DeletedSessionTokenDecryptError extends Error {
  constructor() {
    super("Deleted session token material could not be decrypted.");
    this.name = "DeletedSessionTokenDecryptError";
  }
}

/**
 * The Keycloak session behind a callback has ended: at Keycloak's own
 * `sky_session_expires`, or, without it, `OIDC_UPSTREAM_SESSION_MAX_SECONDS`
 * after it began.
 */
export class UpstreamSessionExpiredError extends Error {
  constructor() {
    super("Upstream authentication session has expired.");
    this.name = "UpstreamSessionExpiredError";
  }
}

export class ActiveSessionTokenDecryptError extends Error {
  constructor() {
    super("Active session token material could not be decrypted.");
    this.name = "ActiveSessionTokenDecryptError";
  }
}

export class SessionManager {
  constructor(
    private readonly repository: SessionRepository,
    private readonly cipher: SecretCipher,
    private readonly csrfSecret: Buffer,
    private readonly policy: SessionPolicy,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(input: {
    subject: string;
    keycloakSid?: string;
    authenticatedAt: Date;
    /**
     * When the Keycloak session behind these tokens began, if not at
     * `authenticatedAt` (Keycloak's `sky_session_started`, or the callback
     * time of a native handoff). A native or Web handoff opens a fresh
     * Keycloak session that carries the app's original `auth_time`; its
     * lifetime starts with the handoff, while `auth_time` keeps saying when
     * the person last logged in.
     */
    upstreamSessionStartedAt?: Date;
    /**
     * When Keycloak itself ends the session behind these tokens
     * (`sky_session_expires`: its max lifespan, remember-me and client
     * overrides included). When given it replaces the start +
     * `upstreamSessionMaxSeconds` estimate; the local cap still applies.
     */
    upstreamSessionExpiresAt?: Date;
    tokens: OidcTokenSet;
  }) {
    if (!input.subject || input.subject.length > 255) throw new Error("Invalid OIDC subject.");
    const id = randomUUID();
    const handle = randomOpaqueValue();
    const now = this.clock();
    const authenticatedAtMs = input.authenticatedAt.getTime();
    if (!Number.isFinite(authenticatedAtMs) || authenticatedAtMs > now.getTime() + 5_000) {
      throw new Error("Invalid upstream authentication time.");
    }
    const absoluteExpiresAt = new Date(Math.min(
      now.getTime() + this.policy.absoluteTtlSeconds * 1_000,
      this.#upstreamSessionEnd(input, authenticatedAtMs, now),
    ));
    if (absoluteExpiresAt <= now) {
      throw new UpstreamSessionExpiredError();
    }
    const idleExpiresAt = new Date(
      Math.min(absoluteExpiresAt.getTime(), now.getTime() + this.policy.idleTtlSeconds * 1_000),
    );

    await this.repository.insert({
      id,
      subject: input.subject,
      keycloakSid: input.keycloakSid ?? null,
      handleHash: sha256(handle),
      tokenCiphertext: this.cipher.encrypt(input.tokens, `session:${id}`),
      createdAt: now,
      rotatedAt: now,
      lastSeenAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
    });

    return { handle, absoluteExpiresAt };
  }

  #upstreamSessionEnd(
    input: { upstreamSessionStartedAt?: Date; upstreamSessionExpiresAt?: Date },
    authenticatedAtMs: number,
    now: Date,
  ) {
    if (input.upstreamSessionExpiresAt) {
      const expiresAtMs = input.upstreamSessionExpiresAt.getTime();
      if (!Number.isFinite(expiresAtMs)) throw new Error("Invalid upstream session expiry.");
      return expiresAtMs;
    }
    const upstreamStartedAtMs = input.upstreamSessionStartedAt?.getTime() ?? authenticatedAtMs;
    if (!Number.isFinite(upstreamStartedAtMs) || upstreamStartedAtMs > now.getTime() + 5_000) {
      throw new Error("Invalid upstream session start time.");
    }
    return upstreamStartedAtMs + this.policy.upstreamSessionMaxSeconds * 1_000;
  }

  async #useHandle(
    handle: string | undefined,
    options: { allowRotation?: boolean; csrfToken?: string } = {},
  ): Promise<BrowserSession | "proof_rejected" | null> {
    if (!handle || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return null;
    if (options.csrfToken !== undefined && options.csrfToken.length > 128) return "proof_rejected";
    const replacementHandle = randomOpaqueValue();
    const result = await this.repository.useHandle({
      handleHash: sha256(handle),
      replacementHandleHash: sha256(replacementHandle),
      now: this.clock(),
      idleTtlSeconds: this.policy.idleTtlSeconds,
      rotateAfterSeconds: this.policy.rotationSeconds,
      previousHandleGraceSeconds: this.policy.previousHandleGraceSeconds,
      allowRotation: options.allowRotation ?? false,
      ...(options.csrfToken !== undefined
        ? { authorizeSessionId: (sessionId: string) => this.verifyCsrf(sessionId, options.csrfToken) }
        : {}),
    });
    if (!result) return null;
    if ("proofRejected" in result) return "proof_rejected";
    return {
      ...result,
      ...(result.rotated ? { rotatedHandle: replacementHandle } : {}),
    };
  }

  async candidate(handle: string | undefined) {
    if (!handle || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return null;
    return this.repository.findByHandle(sha256(handle), this.clock());
  }

  async authenticate(
    handle: string | undefined,
    options: { allowRotation?: boolean } = {},
  ): Promise<BrowserSession | null> {
    const result = await this.#useHandle(handle, options);
    return result === "proof_rejected" ? null : result;
  }

  async authenticateMutation(
    handle: string | undefined,
    csrfToken: string | undefined,
    options: { allowRotation?: boolean } = {},
  ): Promise<
    | { status: "active"; value: BrowserSession }
    | { status: "forbidden" }
    | { status: "missing" }
  > {
    if (!csrfToken) return { status: "forbidden" };
    const result = await this.#useHandle(handle, { ...options, csrfToken });
    if (result === "proof_rejected") return { status: "forbidden" };
    if (!result) return { status: "missing" };
    return { status: "active", value: result };
  }

  csrfToken(sessionId: string) {
    return sessionCsrfToken(this.csrfSecret, sessionId);
  }

  verifyCsrf(sessionId: string, candidate: string | undefined) {
    if (!candidate || candidate.length > 128) return false;
    return constantTimeEqual(this.csrfToken(sessionId), candidate);
  }

  credentialReference(sessionId: string, credentialId: string) {
    return hmacSha256(
      this.csrfSecret,
      "owned-credential-reference",
      `${sessionId}\0${credentialId}`,
    ).toString("base64url");
  }

  upstreamSessionReference(sessionId: string, upstreamSessionId: string) {
    return upstreamSessionReference(this.csrfSecret, sessionId, upstreamSessionId);
  }

  verifyUpstreamSessionReference(
    sessionId: string,
    upstreamSessionId: string,
    candidate: string,
  ) {
    return constantTimeEqual(
      this.upstreamSessionReference(sessionId, upstreamSessionId),
      candidate,
    );
  }

  async revokeHandle(handle: string | undefined) {
    if (!handle || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return false;
    return this.repository.revokeByHandle(sha256(handle), this.clock());
  }

  revokeSubject(subject: string) {
    return this.repository.revokeBySubject(subject, this.clock());
  }

  revokeSubjectSessionsBySessionId(sessionId: string) {
    return this.repository.revokeSubjectBySessionId(sessionId, this.clock());
  }

  async authenticateCleanupMutation(
    handle: string | undefined,
    csrfToken: string | undefined,
  ): Promise<
    | { status: "active"; value: { session: ActiveSession } }
    | { status: "forbidden" }
    | { status: "missing" }
  > {
    if (!csrfToken) return { status: "forbidden" };
    const session = await this.candidate(handle);
    if (!session) return { status: "missing" };
    if (!this.verifyCsrf(session.id, csrfToken)) return { status: "forbidden" };
    return { status: "active", value: { session } };
  }

  async readTokens(id: string) {
    const ciphertext = await this.repository.getTokenCiphertext(id, this.clock());
    if (!ciphertext) return null;
    try {
      return {
        tokens: this.cipher.decrypt<OidcTokenSet>(ciphertext, `session:${id}`),
        version: ciphertext,
      };
    } catch {
      throw new ActiveSessionTokenDecryptError();
    }
  }

  async replaceTokens(
    id: string,
    expectedVersion: string,
    tokens: OidcTokenSet,
    keycloakSid?: string,
  ) {
    const replacement = this.cipher.encrypt(tokens, `session:${id}`);
    return this.repository.replaceTokenCiphertext(
      id,
      expectedVersion,
      replacement,
      keycloakSid,
      this.clock(),
    );
  }

  revokeSession(id: string) {
    return this.repository.revokeById(id, this.clock());
  }

  async deleteSessionAndGetTokens(id: string) {
    const encrypted = await this.repository.deleteByIdReturningToken(id);
    if (!encrypted) return null;
    try {
      return this.cipher.decrypt<OidcTokenSet>(encrypted, `session:${id}`);
    } catch {
      throw new DeletedSessionTokenDecryptError();
    }
  }
}
