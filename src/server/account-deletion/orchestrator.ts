import "server-only";

import { randomUUID } from "node:crypto";
import { constantTimeEqual, hmacSha256, randomOpaqueValue, sha256 } from "@/server/auth/crypto";
import type { SecretCipher } from "@/server/auth/crypto";
import type { ActiveSession } from "@/server/auth/types";
import type {
  AcceptedAccountDeletionIntent,
  AccountDeletionRepository,
  AwaitingConfirmationIntent,
  CoreAccountDeletionGateway,
  CoreAccountDeletionStatus,
  LocalRecoveryIntent,
  ReauthenticatedDeletionInput,
  SubjectSessionRevoker,
} from "@/server/account-deletion/types";

const FRESH_AUTH_WINDOW_MS = 5 * 60 * 1_000;
const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CORE_RECEIPT_PATTERN = /^adr_[A-Za-z0-9_-]{43}$/;
const CONFIRMATION = "HESABIMI SİL";

export class AccountDeletionProofError extends Error {
  constructor(message = "The account deletion proof is invalid or expired.") {
    super(message);
    this.name = "AccountDeletionProofError";
  }
}

export class AccountDeletionUnavailableError extends Error {
  constructor() {
    super("Account deletion is temporarily unavailable.");
    this.name = "AccountDeletionUnavailableError";
  }
}

function publicStatus(intent: AcceptedAccountDeletionIntent) {
  return {
    status: intent.status,
    partial: intent.partial,
    updatedAt: intent.updatedAt.toISOString(),
    completedAt: intent.completedAt?.toISOString() ?? null,
    receiptExpiresAt: intent.receiptExpiresAt?.toISOString() ?? null,
  };
}

export class AccountDeletionOrchestrator {
  constructor(
    private readonly repository: AccountDeletionRepository,
    private readonly core: CoreAccountDeletionGateway,
    private readonly sessions: SubjectSessionRevoker,
    private readonly cipher: SecretCipher,
    private readonly hmacSecret: Buffer,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createReauthenticatedIntent(input: ReauthenticatedDeletionInput) {
    const now = this.clock();
    const authenticatedAt = input.authenticatedAt.getTime();
    if (
      !Number.isFinite(authenticatedAt) ||
      authenticatedAt > now.getTime() + 5_000 ||
      authenticatedAt <= now.getTime() - FRESH_AUTH_WINDOW_MS
    ) {
      throw new AccountDeletionProofError("A fresh authentication is required.");
    }
    if (!input.freshAccessToken || !input.freshIdToken) {
      throw new AccountDeletionProofError("Fresh identity tokens are required.");
    }
    const id = randomUUID();
    const proofReference = randomOpaqueValue();
    const localReceipt = randomOpaqueValue();
    const proofHash = sha256(proofReference);
    const intent = await this.repository.saveReauthentication({
      id,
      stage: "awaiting_confirmation",
      subjectDigest: hmacSha256(this.hmacSecret, "account-deletion-subject", input.session.subject),
      sessionId: input.session.id,
      proofHash,
      localReceiptHash: sha256(localReceipt),
      encryptedIdentityTokens: this.cipher.encrypt(
        { accessToken: input.freshAccessToken, idToken: input.freshIdToken },
        this.#identityRecoveryAad(input.session.id, proofHash),
      ),
      freshUntil: new Date(authenticatedAt + FRESH_AUTH_WINDOW_MS),
      createdAt: now,
      updatedAt: now,
    });
    return { proofReference, localReceipt, freshUntil: intent.freshUntil };
  }

  #idempotencyKey(intentId: string) {
    return hmacSha256(this.hmacSecret, "account-deletion-idempotency", intentId).toString("base64url");
  }

  #identityRecoveryAad(sessionId: string, proofHash: Buffer) {
    return `account-deletion:identity:${sessionId}:${proofHash.toString("base64url")}`;
  }

  #coreReceiptRecoveryAad(intentId: string) {
    return `account-deletion:core-receipt:${intentId}`;
  }

  #decryptRecoveryTokens(intent: AwaitingConfirmationIntent) {
    try {
      const value = this.cipher.decrypt<{ accessToken?: unknown; idToken?: unknown }>(
        intent.encryptedIdentityTokens,
        this.#identityRecoveryAad(intent.sessionId, intent.proofHash),
      );
      if (
        typeof value.accessToken !== "string" || !value.accessToken ||
        typeof value.idToken !== "string" || !value.idToken
      ) throw new Error();
      return { accessToken: value.accessToken, reauthenticationToken: value.idToken };
    } catch {
      throw new AccountDeletionUnavailableError();
    }
  }

  #decryptRecoveryReceipt(intent: LocalRecoveryIntent) {
    try {
      const value = this.cipher.decrypt<{ receipt?: unknown }>(
        intent.encryptedCoreReceipt,
        this.#coreReceiptRecoveryAad(intent.id),
      );
      if (typeof value.receipt !== "string" || !CORE_RECEIPT_PATTERN.test(value.receipt)) {
        throw new Error();
      }
      return value.receipt;
    } catch {
      throw new AccountDeletionUnavailableError();
    }
  }

  #encryptedCoreReceipt(intentId: string, receipt: string) {
    return this.cipher.encrypt({ receipt }, this.#coreReceiptRecoveryAad(intentId));
  }

  async #acceptCore(
    intent: AwaitingConfirmationIntent,
    status: CoreAccountDeletionStatus,
  ) {
    if (!CORE_RECEIPT_PATTERN.test(status.receipt)) throw new AccountDeletionUnavailableError();
    const saved = await this.repository.acceptCore(
      intent,
      status,
      sha256(status.receipt),
      this.#encryptedCoreReceipt(intent.id, status.receipt),
    );
    if (!saved) throw new AccountDeletionUnavailableError();
    return { saved, receipt: status.receipt };
  }

  async #refreshLocalRecovery(
    intent: LocalRecoveryIntent,
    status: CoreAccountDeletionStatus,
  ) {
    if (!CORE_RECEIPT_PATTERN.test(status.receipt)) throw new AccountDeletionUnavailableError();
    if (!intent.coreReceiptHash.equals(sha256(status.receipt))) {
      throw new AccountDeletionUnavailableError();
    }
    const saved = await this.repository.refreshLocalRecovery(
      intent,
      status,
      this.#encryptedCoreReceipt(intent.id, status.receipt),
    );
    if (!saved) throw new AccountDeletionUnavailableError();
    return { saved, receipt: status.receipt };
  }

  async #recordCoreReceipt(
    intent: AcceptedAccountDeletionIntent,
    status: CoreAccountDeletionStatus,
  ) {
    if (
      !CORE_RECEIPT_PATTERN.test(status.receipt) ||
      !intent.coreReceiptHash.equals(sha256(status.receipt))
    ) throw new AccountDeletionUnavailableError();
    const saved = await this.repository.recordCoreReceiptStatus(intent, status);
    if (!saved) throw new AccountDeletionUnavailableError();
    return { saved, receipt: status.receipt };
  }

  async #revokeLocalSessionsBeforeAccepting(intent: AwaitingConfirmationIntent) {
    try {
      await this.sessions.revokeSubjectSessionsBySessionId(intent.sessionId);
    } catch {
      throw new AccountDeletionUnavailableError();
    }
  }

  async submit(input: {
    session: ActiveSession;
    proofReference: string;
    localReceipt: string;
    confirmation: string;
  }) {
    if (input.confirmation !== CONFIRMATION) {
      throw new AccountDeletionProofError("The confirmation text does not match.");
    }
    if (!REFERENCE_PATTERN.test(input.proofReference) || !REFERENCE_PATTERN.test(input.localReceipt)) {
      throw new AccountDeletionProofError();
    }
    const intent = await this.repository.findAwaitingByProof(
      sha256(input.proofReference),
      input.session.id,
      this.clock(),
    );
    if (!intent || !intent.localReceiptHash.equals(sha256(input.localReceipt))) {
      throw new AccountDeletionProofError();
    }
    const expectedSubject = hmacSha256(
      this.hmacSecret,
      "account-deletion-subject",
      input.session.subject,
    );
    if (!intent.subjectDigest.equals(expectedSubject)) throw new AccountDeletionProofError();

    let status: CoreAccountDeletionStatus;
    try {
      status = await this.core.initiate({
        ...this.#decryptRecoveryTokens(intent),
        idempotencyKey: this.#idempotencyKey(intent.id),
      });
    } catch (error) {
      if (error instanceof AccountDeletionUnavailableError) throw error;
      throw new AccountDeletionUnavailableError();
    }
    await this.#revokeLocalSessionsBeforeAccepting(intent);
    const { saved, receipt } = await this.#acceptCore(intent, status);
    return { ...publicStatus(saved), receipt };
  }

  async status(receipt: string) {
    if (!REFERENCE_PATTERN.test(receipt) && !CORE_RECEIPT_PATTERN.test(receipt)) return null;
    const intent = await this.repository.findByReceipt(sha256(receipt), this.clock());
    if (!intent) return null;
    let current: CoreAccountDeletionStatus;
    let recorded: { saved: AcceptedAccountDeletionIntent; receipt: string };
    try {
      if (intent.stage === "awaiting_confirmation") {
        current = await this.core.initiate({
          ...this.#decryptRecoveryTokens(intent),
          idempotencyKey: this.#idempotencyKey(intent.id),
        });
        await this.#revokeLocalSessionsBeforeAccepting(intent);
        recorded = await this.#acceptCore(intent, current);
      } else if (intent.stage === "local_recovery") {
        const usedCoreReceipt = intent.coreReceiptHash.equals(sha256(receipt));
        const coreReceipt = usedCoreReceipt ? receipt : this.#decryptRecoveryReceipt(intent);
        current = await this.core.status(coreReceipt);
        recorded = usedCoreReceipt
          ? await this.#recordCoreReceipt(intent, current)
          : await this.#refreshLocalRecovery(intent, current);
      } else {
        current = await this.core.status(receipt);
        recorded = await this.#recordCoreReceipt(intent, current);
      }
    } catch (error) {
      if (error instanceof AccountDeletionUnavailableError) throw error;
      throw new AccountDeletionUnavailableError();
    }
    return { ...publicStatus(recorded.saved), receipt: recorded.receipt };
  }

  async retry(receipt: string) {
    if (!CORE_RECEIPT_PATTERN.test(receipt)) throw new AccountDeletionProofError();
    const intent = await this.repository.findByReceipt(sha256(receipt), this.clock());
    if (
      !intent ||
      intent.stage === "awaiting_confirmation" ||
      !intent.coreReceiptHash.equals(sha256(receipt)) ||
      intent.status !== "manual_intervention"
    ) {
      throw new AccountDeletionProofError();
    }
    let current: CoreAccountDeletionStatus;
    try {
      current = await this.core.retry(receipt);
    } catch {
      throw new AccountDeletionUnavailableError();
    }
    const { saved, receipt: coreReceipt } = await this.#recordCoreReceipt(intent, current);
    return { ...publicStatus(saved), receipt: coreReceipt };
  }

  receiptCsrfToken(receipt: string) {
    if (!CORE_RECEIPT_PATTERN.test(receipt)) throw new AccountDeletionProofError();
    return hmacSha256(this.hmacSecret, "account-deletion-receipt-csrf", receipt)
      .toString("base64url");
  }

  verifyReceiptCsrf(receipt: string, candidate: string | undefined) {
    if (!candidate || candidate.length > 128 || !CORE_RECEIPT_PATTERN.test(receipt)) return false;
    return constantTimeEqual(this.receiptCsrfToken(receipt), candidate);
  }
}
