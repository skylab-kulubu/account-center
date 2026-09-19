import type {
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
  replacementHandleHash: Buffer;
  now: Date;
  idleTtlSeconds: number;
  rotateAfterSeconds: number;
  previousHandleGraceSeconds: number;
  allowRotation: boolean;
  authorizeSessionId?: (sessionId: string) => boolean;
};

export type SessionUseOutcome = SessionUseResult | { proofRejected: true };

export interface SessionRepository {
  insert(session: NewSessionRecord): Promise<void>;
  useHandle(input: UseSessionInput): Promise<SessionUseOutcome | null>;
  getTokenCiphertext(id: string, now: Date): Promise<string | null>;
  replaceTokenCiphertext(
    id: string,
    expectedCiphertext: string,
    replacementCiphertext: string,
    now: Date,
  ): Promise<boolean>;
  revokeByHandle(handleHash: Buffer, revokedAt: Date): Promise<boolean>;
  revokeById(id: string, revokedAt: Date): Promise<boolean>;
  deleteByIdReturningToken(id: string): Promise<string | null>;
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
