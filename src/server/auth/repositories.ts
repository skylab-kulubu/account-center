import type {
  ActiveSession,
  NewSessionRecord,
  SessionUseResult,
  StoredOidcTransaction,
} from "@/server/auth/types";

export interface OidcTransactionRepository {
  insert(transaction: StoredOidcTransaction): Promise<void>;
  consume(
    stateHash: Buffer,
    browserBindingHash: Buffer,
    now: Date,
  ): Promise<{ id: string; payloadCiphertext: string } | null>;
}

export type UseSessionInput = {
  handleHash: Buffer;
  /** The random salt of a rotation this request makes (a fresh one per request). */
  newRotationSalt: Buffer;
  /**
   * The SHA-256 of the presented handle's successor under a rotation salt: the successor is derived
   * from the handle and the salt (SessionManager), so every request carrying the same previous handle
   * gets the same successor back.
   */
  successorHash: (salt: Buffer) => Buffer;
  now: Date;
  idleTtlSeconds: number;
  rotateAfterSeconds: number;
  previousHandleGraceSeconds: number;
  allowRotation: boolean;
  authorizeSessionId?: (sessionId: string) => boolean;
};

/** `rotationSalt`: the salt the successor was derived under, when the answer hands one out. */
export type SessionUseOutcome = (SessionUseResult & { rotationSalt?: Buffer }) | { proofRejected: true };

export interface SessionRepository {
  insert(session: NewSessionRecord): Promise<void>;
  findByHandle(handleHash: Buffer, now: Date): Promise<ActiveSession | null>;
  useHandle(input: UseSessionInput): Promise<SessionUseOutcome | null>;
  getTokenCiphertext(id: string, now: Date): Promise<string | null>;
  replaceTokenCiphertext(
    id: string,
    expectedCiphertext: string,
    replacementCiphertext: string,
    keycloakSid: string | undefined,
    now: Date,
  ): Promise<boolean>;
  revokeByHandle(handleHash: Buffer, revokedAt: Date): Promise<boolean>;
  revokeBySubject(subject: string, revokedAt: Date): Promise<number>;
  revokeSubjectBySessionId(sessionId: string, revokedAt: Date): Promise<number>;
  revokeById(id: string, revokedAt: Date): Promise<boolean>;
  deleteByIdReturningToken(id: string): Promise<string | null>;
}

export type StoredSudo = {
  ciphertext: string;
  expiresAt: Date;
};

/**
 * Encrypted sudo token material on the active session record. A sudo entry
 * only exists while the session itself is active; revocation, expiry and
 * deletion of the session take the sudo material with them.
 */
export interface SudoRepository {
  replaceSudo(sessionId: string, ciphertext: string, expiresAt: Date, now: Date): Promise<boolean>;
  readSudo(sessionId: string, now: Date): Promise<StoredSudo | null>;
  clearSudo(sessionId: string): Promise<void>;
}

export type BackchannelLogoutInput = {
  jtiHash: Buffer;
  seenAt: Date;
  replayExpiresAt: Date;
  keycloakSid?: string;
  subject?: string;
};

export interface BackchannelLogoutRepository {
  consumeAndDeleteSessions(input: BackchannelLogoutInput): Promise<{
    accepted: boolean;
    deletedSessions: number;
  }>;
}

export type RateLimitInput = {
  keyHash: Buffer;
  windowStartedAt: Date;
  windowExpiresAt: Date;
  limit: number;
};

export interface RateLimitRepository {
  consume(input: RateLimitInput): Promise<{ allowed: boolean; count: number }>;
}
