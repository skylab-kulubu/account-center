import type { ActiveSession } from "@/server/auth/types";

export type ActiveAccountDeletionStatus =
  | "blocking"
  | "pending"
  | "processing"
  | "manual_intervention";

type CoreAccountDeletionBase = {
  receipt: string;
  requestedAt: string;
  updatedAt: string;
  receiptExpiresAt: string;
};

export type CoreAccountDeletionStatus = CoreAccountDeletionBase & (
  | {
      status: ActiveAccountDeletionStatus;
      partial: boolean;
      completedAt: null;
    }
  | {
      status: "completed";
      partial: false;
      completedAt: string;
    }
);

type IntentIdentity = {
  id: string;
  freshUntil: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type AwaitingConfirmationIntent = IntentIdentity & {
  stage: "awaiting_confirmation";
  subjectDigest: Buffer;
  sessionId: string;
  proofHash: Buffer;
  localReceiptHash: Buffer;
  encryptedIdentityTokens: string;
  /**
   * When submit recorded the typed confirmation under the current proof, or
   * null. Only a confirmed intent may reach core from the status route.
   */
  confirmedAt: Date | null;
};

type AcceptedIntentBase = IntentIdentity & {
  coreReceiptHash: Buffer;
  requestedAt: Date;
  receiptExpiresAt: Date;
};

type AcceptedIntentStatus =
  | {
      status: ActiveAccountDeletionStatus;
      partial: boolean;
      completedAt: null;
    }
  | {
      status: "completed";
      partial: false;
      completedAt: Date;
    };

export type LocalRecoveryIntent = AcceptedIntentBase & AcceptedIntentStatus & {
  stage: "local_recovery";
  localReceiptHash: Buffer;
  encryptedCoreReceipt: string;
};

export type CoreReceiptIntent = AcceptedIntentBase & AcceptedIntentStatus & {
  stage: "core_receipt";
};

export type AcceptedAccountDeletionIntent = LocalRecoveryIntent | CoreReceiptIntent;
export type AccountDeletionIntent = AwaitingConfirmationIntent | AcceptedAccountDeletionIntent;

export interface AccountDeletionRepository {
  saveReauthentication(input: AwaitingConfirmationIntent): Promise<AwaitingConfirmationIntent>;
  findAwaitingByProof(
    proofHash: Buffer,
    sessionId: string,
    now: Date,
  ): Promise<AwaitingConfirmationIntent | null>;
  findByReceipt(receiptHash: Buffer, now: Date): Promise<AccountDeletionIntent | null>;
  /**
   * Durably records the typed confirmation for this intent under its current
   * proof, session and local receipt, inside the fresh window. Null when the
   * intent no longer matches. A repeated confirmation keeps the first time.
   */
  confirm(intent: AwaitingConfirmationIntent, now: Date): Promise<AwaitingConfirmationIntent | null>;
  /** Voids the confirmation recorded under this intent's proof, if any. */
  withdrawConfirmation(intent: AwaitingConfirmationIntent): Promise<void>;
  acceptCore(
    intent: AwaitingConfirmationIntent,
    status: CoreAccountDeletionStatus,
    coreReceiptHash: Buffer,
    encryptedCoreReceipt: string,
  ): Promise<LocalRecoveryIntent | null>;
  refreshLocalRecovery(
    intent: LocalRecoveryIntent,
    status: CoreAccountDeletionStatus,
    encryptedCoreReceipt: string,
  ): Promise<LocalRecoveryIntent | null>;
  recordCoreReceiptStatus(
    intent: AcceptedAccountDeletionIntent,
    status: CoreAccountDeletionStatus,
  ): Promise<CoreReceiptIntent | null>;
}

export interface CoreAccountDeletionGateway {
  /** `sudoToken` is the opaque sky-account Sudo mode token, sent as `X-Sky-Sudo`. */
  initiate(input: {
    accessToken: string;
    sudoToken: string;
    idempotencyKey: string;
  }): Promise<CoreAccountDeletionStatus>;
  status(receipt: string): Promise<CoreAccountDeletionStatus>;
  retry(receipt: string): Promise<CoreAccountDeletionStatus>;
}

export type SubjectSessionRevoker = {
  revokeSubjectSessionsBySessionId(sessionId: string): Promise<number>;
};

/**
 * What `POST .../deletion/prepare` hands the orchestrator: the Account REST
 * bearer with its own expiry, and the session's current Sudo mode proof,
 * read through the same gate every `X-Sky-Sudo` route uses
 * (`requireAccountSpiSudo`).
 */
export type ReauthenticatedDeletionInput = {
  session: ActiveSession;
  accessToken: string;
  accessTokenExpiresAt: Date;
  sudo: { sudoToken: string; expiresAt: Date };
};
