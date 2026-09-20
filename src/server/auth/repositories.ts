import type {
  ActiveSession,
  NativeBridgeRedemption,
  NativeHandoffIdentity,
  NewNativeHandoff,
  NewSessionRecord,
  SessionUseResult,
  StoredAccountActionResult,
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

export interface AccountActionResultRepository {
  insert(result: StoredAccountActionResult): Promise<void>;
  read(
    resultHash: Buffer,
    sessionId: string,
    now: Date,
  ): Promise<Pick<StoredAccountActionResult, "action" | "outcome"> | null>;
  consume(
    resultHash: Buffer,
    sessionId: string,
    now: Date,
  ): Promise<Pick<StoredAccountActionResult, "action" | "outcome"> | null>;
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

export type ConsumeNativeHandoffInput = {
  publicCodeHash: Buffer;
  bridgeId: string;
  bridgeCodeHash: Buffer;
  now: Date;
  bridgeExpiresAt: Date;
};

export type RedeemNativeBridgeInput = {
  bridgeCodeHash: Buffer;
  requestNonceHash: Buffer;
  now: Date;
  requestNonceExpiresAt: Date;
};

export interface NativeHandoffRepository {
  insert(handoff: NewNativeHandoff): Promise<void>;
  findActiveHandoff(codeHash: Buffer, now: Date): Promise<NativeHandoffIdentity | null>;
  consumeAndCreateBridge(input: ConsumeNativeHandoffInput): Promise<NativeHandoffIdentity | null>;
  findActiveBridge(codeHash: Buffer, now: Date): Promise<NativeBridgeRedemption | null>;
  redeemBridge(input: RedeemNativeBridgeInput): Promise<NativeBridgeRedemption | null>;
}
