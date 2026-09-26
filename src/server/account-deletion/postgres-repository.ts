import "server-only";

import type { Pool } from "pg";
import type {
  AcceptedAccountDeletionIntent,
  AccountDeletionIntent,
  AccountDeletionRepository,
  ActiveAccountDeletionStatus,
  AwaitingConfirmationIntent,
  CoreAccountDeletionStatus,
  LocalRecoveryIntent,
} from "@/server/account-deletion/types";

type PersistedStatus = "awaiting_confirmation" | ActiveAccountDeletionStatus | "completed";

type IntentRow = {
  id: string;
  subject_digest: Buffer | null;
  session_id: string | null;
  proof_hash: Buffer | null;
  local_receipt_hash: Buffer | null;
  core_receipt_hash: Buffer | null;
  recovery_kind: "identity_tokens" | "core_receipt" | null;
  recovery_ciphertext: string | null;
  status: PersistedStatus;
  partial: boolean;
  requested_at: Date | null;
  completed_at: Date | null;
  receipt_expires_at: Date | null;
  fresh_until: Date;
  created_at: Date;
  updated_at: Date;
  /** Only the reads that join `account_deletion_confirmations` carry it. */
  confirmed_at?: Date | null;
};

const columns = `id, subject_digest, session_id, proof_hash, local_receipt_hash,
  core_receipt_hash, recovery_kind, recovery_ciphertext, status, partial, requested_at,
  completed_at, receipt_expires_at, fresh_until, created_at, updated_at`;
/**
 * The intent columns plus the typed confirmation recorded under the intent's
 * current proof. A confirmation typed under an earlier proof does not join.
 */
const confirmedColumns = `intent.id, intent.subject_digest, intent.session_id, intent.proof_hash,
  intent.local_receipt_hash, intent.core_receipt_hash, intent.recovery_kind,
  intent.recovery_ciphertext, intent.status, intent.partial, intent.requested_at,
  intent.completed_at, intent.receipt_expires_at, intent.fresh_until, intent.created_at,
  intent.updated_at, confirmation.confirmed_at`;
const confirmedIntents = `account_deletion_intents AS intent
  LEFT JOIN account_deletion_confirmations AS confirmation
    ON confirmation.intent_id = intent.id
   AND confirmation.proof_hash = intent.proof_hash`;
const activeStatuses = new Set<ActiveAccountDeletionStatus>([
  "blocking",
  "pending",
  "processing",
  "manual_intervention",
]);
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function invalidPersistedState(): never {
  throw new Error("Invalid persisted account deletion lifecycle state.");
}

function isDigest(value: Buffer | null): value is Buffer {
  return Buffer.isBuffer(value) && value.byteLength === 32;
}

function intent(row: IntentRow): AccountDeletionIntent {
  if (row.fresh_until <= row.created_at || row.updated_at < row.created_at) {
    return invalidPersistedState();
  }
  const identity = {
    id: row.id,
    freshUntil: row.fresh_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.status === "awaiting_confirmation") {
    if (
      !isDigest(row.subject_digest) ||
      !row.session_id ||
      !isDigest(row.proof_hash) ||
      !isDigest(row.local_receipt_hash) ||
      row.core_receipt_hash !== null ||
      row.recovery_kind !== "identity_tokens" ||
      !row.recovery_ciphertext ||
      row.partial ||
      row.requested_at !== null ||
      row.completed_at !== null ||
      row.receipt_expires_at !== null
    ) return invalidPersistedState();
    return {
      ...identity,
      stage: "awaiting_confirmation",
      subjectDigest: row.subject_digest,
      sessionId: row.session_id,
      proofHash: row.proof_hash,
      localReceiptHash: row.local_receipt_hash,
      encryptedIdentityTokens: row.recovery_ciphertext,
      confirmedAt: row.confirmed_at ?? null,
    };
  }

  if (
    row.subject_digest !== null ||
    row.session_id !== null ||
    row.proof_hash !== null ||
    !isDigest(row.core_receipt_hash) ||
    !row.requested_at ||
    !row.receipt_expires_at ||
    row.updated_at < row.requested_at ||
    row.receipt_expires_at <= row.updated_at
  ) return invalidPersistedState();

  const lifecycleStatus = row.status === "completed"
    ? row.completed_at && !row.partial
      ? { status: "completed" as const, partial: false as const, completedAt: row.completed_at }
      : invalidPersistedState()
    : activeStatuses.has(row.status)
      ? row.completed_at === null
        ? {
            status: row.status as ActiveAccountDeletionStatus,
            partial: row.partial,
            completedAt: null,
          }
        : invalidPersistedState()
      : invalidPersistedState();
  if (
    lifecycleStatus.completedAt &&
    (lifecycleStatus.completedAt < row.requested_at || lifecycleStatus.completedAt > row.updated_at)
  ) return invalidPersistedState();

  const accepted = {
    ...identity,
    ...lifecycleStatus,
    coreReceiptHash: row.core_receipt_hash,
    requestedAt: row.requested_at,
    receiptExpiresAt: row.receipt_expires_at,
  };
  if (
    isDigest(row.local_receipt_hash) &&
    row.recovery_kind === "core_receipt" &&
    row.recovery_ciphertext
  ) {
    return {
      ...accepted,
      stage: "local_recovery",
      localReceiptHash: row.local_receipt_hash,
      encryptedCoreReceipt: row.recovery_ciphertext,
    };
  }
  if (
    row.local_receipt_hash === null &&
    row.recovery_kind === null &&
    row.recovery_ciphertext === null
  ) {
    return { ...accepted, stage: "core_receipt" };
  }
  return invalidPersistedState();
}

function parsedDate(value: string, field: string) {
  const result = new Date(value);
  if (!RFC3339_UTC.test(value) || !Number.isFinite(result.getTime())) {
    throw new Error(`Invalid Core account deletion ${field}.`);
  }
  return result;
}

function coreDates(status: CoreAccountDeletionStatus) {
  const requestedAt = parsedDate(status.requestedAt, "requestedAt");
  const updatedAt = parsedDate(status.updatedAt, "updatedAt");
  const receiptExpiresAt = parsedDate(status.receiptExpiresAt, "receiptExpiresAt");
  const completedAt = status.status === "completed"
    ? parsedDate(status.completedAt, "completedAt")
    : null;
  if (
    receiptExpiresAt <= updatedAt ||
    updatedAt < requestedAt ||
    (completedAt !== null && (completedAt < requestedAt || completedAt > updatedAt))
  ) {
    throw new Error("Invalid Core account deletion chronology.");
  }
  return { requestedAt, updatedAt, receiptExpiresAt, completedAt };
}

/**
 * The stored status stays only when it is known to be newer than core's:
 * - `completed` is terminal in core. A stored one never changes, and an
 *   incoming one always wins, whatever its `updated_at`.
 * - Otherwise the stored status stays while its `updated_at` is newer than
 *   core's and not in the future. An older core wrote the next attempt's time
 *   into `updated_at`; such a stamp proves nothing and must not hide a retry's
 *   or a completion's status (account-erasure ticket 13).
 */
const storedStatusStays = `(status = 'completed'
    OR ($3 <> 'completed' AND updated_at > $6 AND updated_at <= now()))`;

const statusUpdate = `status = CASE
    WHEN ${storedStatusStays} THEN status
    ELSE $3
  END,
  partial = CASE
    WHEN ${storedStatusStays} THEN partial
    ELSE $4
  END,
  requested_at = COALESCE(requested_at, $5),
  updated_at = CASE
    WHEN status <> 'completed' AND updated_at > now() THEN GREATEST(created_at, $6)
    ELSE GREATEST(updated_at, $6)
  END,
  completed_at = CASE
    WHEN ${storedStatusStays} THEN completed_at
    ELSE $7
  END,
  receipt_expires_at = GREATEST(COALESCE(receipt_expires_at, $8), $8)`;

function statusParameters(id: string, coreReceiptHash: Buffer, status: CoreAccountDeletionStatus) {
  const dates = coreDates(status);
  return [
    id,
    coreReceiptHash,
    status.status,
    status.partial,
    dates.requestedAt,
    dates.updatedAt,
    dates.completedAt,
    dates.receiptExpiresAt,
  ];
}

export class PostgresAccountDeletionRepository implements AccountDeletionRepository {
  constructor(private readonly pool: Pool) {}

  async saveReauthentication(input: AwaitingConfirmationIntent) {
    const result = await this.pool.query<IntentRow>(
      `INSERT INTO account_deletion_intents
         (id, subject_digest, session_id, proof_hash, local_receipt_hash,
          core_receipt_hash, recovery_kind, recovery_ciphertext, status, partial,
          requested_at, completed_at, receipt_expires_at, fresh_until, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'identity_tokens', $6, 'awaiting_confirmation', false,
               NULL, NULL, NULL, $7, $8, $9)
       ON CONFLICT (subject_digest) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             proof_hash = EXCLUDED.proof_hash,
             local_receipt_hash = EXCLUDED.local_receipt_hash,
             recovery_kind = EXCLUDED.recovery_kind,
             recovery_ciphertext = EXCLUDED.recovery_ciphertext,
             fresh_until = EXCLUDED.fresh_until,
             updated_at = EXCLUDED.updated_at
       WHERE account_deletion_intents.status = 'awaiting_confirmation'
       RETURNING ${columns}`,
      [
        input.id,
        input.subjectDigest,
        input.sessionId,
        input.proofHash,
        input.localReceiptHash,
        input.encryptedIdentityTokens,
        input.freshUntil,
        input.createdAt,
        input.updatedAt,
      ],
    );
    const row = result.rows[0];
    if (row) {
      const saved = intent(row);
      if (saved.stage !== "awaiting_confirmation") return invalidPersistedState();
      return saved;
    }
    const existing = await this.pool.query<IntentRow>(
      `SELECT ${columns} FROM account_deletion_intents WHERE subject_digest = $1`,
      [input.subjectDigest],
    );
    const saved = existing.rows[0] ? intent(existing.rows[0]) : null;
    if (!saved || saved.stage !== "awaiting_confirmation") {
      throw new Error("Account deletion intent could not be persisted.");
    }
    return saved;
  }

  async findAwaitingByProof(proofHash: Buffer, sessionId: string, now: Date) {
    const result = await this.pool.query<IntentRow>(
      `SELECT ${confirmedColumns}
         FROM ${confirmedIntents}
        WHERE intent.proof_hash = $1
          AND intent.session_id = $2
          AND intent.status = 'awaiting_confirmation'
          AND intent.fresh_until > $3`,
      [proofHash, sessionId, now],
    );
    if (!result.rows[0]) return null;
    const saved = intent(result.rows[0]);
    return saved.stage === "awaiting_confirmation" ? saved : invalidPersistedState();
  }

  async findByReceipt(receiptHash: Buffer, now: Date) {
    const result = await this.pool.query<IntentRow>(
      `SELECT ${confirmedColumns}
         FROM ${confirmedIntents}
        WHERE (intent.local_receipt_hash = $1 AND intent.fresh_until > $2)
           OR (intent.core_receipt_hash = $1 AND intent.receipt_expires_at > $2)`,
      [receiptHash, now],
    );
    return result.rows[0] ? intent(result.rows[0]) : null;
  }

  async confirm(awaiting: AwaitingConfirmationIntent, now: Date) {
    const result = await this.pool.query<{ confirmed_at: Date }>(
      `INSERT INTO account_deletion_confirmations (intent_id, proof_hash, confirmed_at)
       SELECT id, proof_hash, $6
         FROM account_deletion_intents
        WHERE id = $1
          AND status = 'awaiting_confirmation'
          AND subject_digest = $2
          AND session_id = $3
          AND proof_hash = $4
          AND local_receipt_hash = $5
          AND fresh_until > $6
       ON CONFLICT (intent_id) DO UPDATE
         SET confirmed_at = CASE
               WHEN account_deletion_confirmations.proof_hash = EXCLUDED.proof_hash
                 THEN account_deletion_confirmations.confirmed_at
               ELSE EXCLUDED.confirmed_at
             END,
             proof_hash = EXCLUDED.proof_hash
       RETURNING confirmed_at`,
      [
        awaiting.id,
        awaiting.subjectDigest,
        awaiting.sessionId,
        awaiting.proofHash,
        awaiting.localReceiptHash,
        now,
      ],
    );
    const confirmedAt = result.rows[0]?.confirmed_at;
    return confirmedAt ? { ...awaiting, confirmedAt } : null;
  }

  async withdrawConfirmation(awaiting: AwaitingConfirmationIntent) {
    await this.pool.query(
      `DELETE FROM account_deletion_confirmations WHERE intent_id = $1 AND proof_hash = $2`,
      [awaiting.id, awaiting.proofHash],
    );
  }

  async acceptCore(
    awaiting: AwaitingConfirmationIntent,
    status: CoreAccountDeletionStatus,
    coreReceiptHash: Buffer,
    encryptedCoreReceipt: string,
  ) {
    // Core acceptance needs the typed confirmation recorded under the same
    // proof, and scrubs it together with the proof it was bound to.
    const result = await this.pool.query<IntentRow>(
      `WITH accepted AS (
         UPDATE account_deletion_intents
            SET subject_digest = NULL,
                session_id = NULL,
                proof_hash = NULL,
                core_receipt_hash = $2,
                recovery_kind = 'core_receipt',
                recovery_ciphertext = $9,
                ${statusUpdate}
          WHERE id = $1
            AND status = 'awaiting_confirmation'
            AND subject_digest = $10
            AND session_id = $11
            AND proof_hash = $12
            AND local_receipt_hash = $13
            AND core_receipt_hash IS NULL
            AND EXISTS (
              SELECT 1
                FROM account_deletion_confirmations
               WHERE intent_id = $1
                 AND proof_hash = $12
            )
        RETURNING ${columns}
       ),
       scrubbed AS (
         DELETE FROM account_deletion_confirmations
          WHERE intent_id IN (SELECT id FROM accepted)
       )
       SELECT * FROM accepted`,
      [
        ...statusParameters(awaiting.id, coreReceiptHash, status),
        encryptedCoreReceipt,
        awaiting.subjectDigest,
        awaiting.sessionId,
        awaiting.proofHash,
        awaiting.localReceiptHash,
      ],
    );
    if (!result.rows[0]) return null;
    const saved = intent(result.rows[0]);
    return saved.stage === "local_recovery" ? saved : invalidPersistedState();
  }

  async refreshLocalRecovery(
    local: LocalRecoveryIntent,
    status: CoreAccountDeletionStatus,
    encryptedCoreReceipt: string,
  ) {
    const result = await this.pool.query<IntentRow>(
      `UPDATE account_deletion_intents
          SET recovery_ciphertext = $9,
              ${statusUpdate}
        WHERE id = $1
          AND status <> 'awaiting_confirmation'
          AND core_receipt_hash = $2
          AND local_receipt_hash = $10
          AND recovery_kind = 'core_receipt'
          AND recovery_ciphertext IS NOT NULL
      RETURNING ${columns}`,
      [
        ...statusParameters(local.id, local.coreReceiptHash, status),
        encryptedCoreReceipt,
        local.localReceiptHash,
      ],
    );
    if (!result.rows[0]) return null;
    const saved = intent(result.rows[0]);
    return saved.stage === "local_recovery" ? saved : invalidPersistedState();
  }

  async recordCoreReceiptStatus(
    accepted: AcceptedAccountDeletionIntent,
    status: CoreAccountDeletionStatus,
  ) {
    const result = await this.pool.query<IntentRow>(
      `UPDATE account_deletion_intents
          SET local_receipt_hash = NULL,
              recovery_kind = NULL,
              recovery_ciphertext = NULL,
              ${statusUpdate}
        WHERE id = $1
          AND status <> 'awaiting_confirmation'
          AND core_receipt_hash = $2
      RETURNING ${columns}`,
      statusParameters(accepted.id, accepted.coreReceiptHash, status),
    );
    if (!result.rows[0]) return null;
    const saved = intent(result.rows[0]);
    return saved.stage === "core_receipt" ? saved : invalidPersistedState();
  }
}
