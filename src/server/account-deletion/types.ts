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
  initiate(input: {
    accessToken: string;
    reauthenticationToken: string;
    idempotencyKey: string;
  }): Promise<CoreAccountDeletionStatus>;
  status(receipt: string): Promise<CoreAccountDeletionStatus>;
  retry(receipt: string): Promise<CoreAccountDeletionStatus>;
}

export type SubjectSessionRevoker = {
  revokeSubjectSessionsBySessionId(sessionId: string): Promise<number>;
};

export type ReauthenticatedDeletionInput = {
  session: ActiveSession;
  authenticatedAt: Date;
  freshAccessToken: string;
  freshIdToken: string;
};
