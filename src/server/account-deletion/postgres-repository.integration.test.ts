// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresAccountDeletionRepository } from "@/server/account-deletion/postgres-repository";
import type {
  AwaitingConfirmationIntent,
  CoreAccountDeletionStatus,
} from "@/server/account-deletion/types";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const processing: CoreAccountDeletionStatus = {
  receipt: `adr_${"r".repeat(43)}`,
  status: "processing",
  partial: true,
  requestedAt: "2026-09-20T12:00:01.000Z",
  updatedAt: "2026-09-20T12:00:02.000Z",
  completedAt: null,
  receiptExpiresAt: "2026-10-20T12:00:01.000Z",
};
const migrationPath = resolve(process.cwd(), "migrations", "0005_account_deletion_intents.sql");
const confirmationMigrationPath = resolve(
  process.cwd(),
  "migrations",
  "0007_account_deletion_confirmations.sql",
);

function awaiting(overrides: Partial<AwaitingConfirmationIntent> = {}): AwaitingConfirmationIntent {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    stage: "awaiting_confirmation",
    subjectDigest: Buffer.alloc(32, 1),
    sessionId: "11111111-1111-4111-8111-111111111111",
    proofHash: Buffer.alloc(32, 2),
    localReceiptHash: Buffer.alloc(32, 3),
    encryptedIdentityTokens: "encrypted-fresh-token",
    confirmedAt: null,
    freshUntil: new Date("2026-09-20T12:05:00.000Z"),
    createdAt: new Date("2026-09-20T12:00:00.000Z"),
    updatedAt: new Date("2026-09-20T12:00:00.000Z"),
    ...overrides,
  };
}

databaseDescribe("PostgreSQL account deletion intents", () => {
  const schema = "account_deletion_repository_test";
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  const repository = new PostgresAccountDeletionRepository(pool);
  let migration = "";
  let confirmationMigration = "";
  let fingerprintSequence = 0;
  const confirmedAt = new Date("2026-09-20T12:01:00.000Z");

  beforeAll(async () => {
    migration = await readFile(migrationPath, "utf8");
    confirmationMigration = await readFile(confirmationMigrationPath, "utf8");
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(migration);
    await pool.query(confirmationMigration);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE account_deletion_intents CASCADE");
  });

  /** Submit's durable record of the typed confirmation, which core acceptance requires. */
  async function confirmed(saved: AwaitingConfirmationIntent) {
    const result = await repository.confirm(saved, confirmedAt);
    if (!result) throw new Error("expected the confirmation to be recorded");
    return result;
  }

  async function inFreshSchema(run: (schemaPool: Pool) => Promise<void>) {
    fingerprintSequence += 1;
    const freshSchema = `account_deletion_fresh_${fingerprintSequence}`;
    await pool.query(`CREATE SCHEMA ${freshSchema}`);
    const schemaPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      options: `-c search_path=${freshSchema}`,
    });
    try {
      await run(schemaPool);
    } finally {
      await schemaPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
    }
  }

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  async function expectFingerprintFailure(alterSql: string, message: RegExp) {
    fingerprintSequence += 1;
    const fingerprintSchema = `account_deletion_fingerprint_${fingerprintSequence}`;
    await pool.query(`CREATE SCHEMA ${fingerprintSchema}`);
    const fingerprintPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      options: `-c search_path=${fingerprintSchema}`,
    });
    try {
      await fingerprintPool.query(migration);
      await fingerprintPool.query(alterSql);
      await expect(fingerprintPool.query(migration)).rejects.toThrow(message);
    } finally {
      await fingerprintPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${fingerprintSchema} CASCADE`);
    }
  }

  it("keeps one durable idempotency id while replacing the current proof and token ciphertext", async () => {
    const first = awaiting();
    await repository.saveReauthentication(first);
    const latest = await repository.saveReauthentication(awaiting({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sessionId: "22222222-2222-4222-8222-222222222222",
      proofHash: Buffer.alloc(32, 4),
      localReceiptHash: Buffer.alloc(32, 5),
      encryptedIdentityTokens: "encrypted-replacement",
      freshUntil: new Date("2026-09-20T12:06:00.000Z"),
      updatedAt: new Date("2026-09-20T12:01:00.000Z"),
    }));

    expect(latest).toMatchObject({
      stage: "awaiting_confirmation",
      id: first.id,
      sessionId: "22222222-2222-4222-8222-222222222222",
      encryptedIdentityTokens: "encrypted-replacement",
    });
    await expect(repository.findAwaitingByProof(
      first.proofHash,
      first.sessionId,
      new Date("2026-09-20T12:04:00.000Z"),
    )).resolves.toBeNull();
    await expect(repository.findAwaitingByProof(
      latest.proofHash,
      latest.sessionId,
      new Date("2026-09-20T12:05:59.999Z"),
    )).resolves.toMatchObject({ id: first.id });
  });

  it("expires proof, local receipt, and encrypted identity-token recovery at the exact fresh deadline", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    const before = new Date(saved.freshUntil.getTime() - 1);
    await expect(repository.findAwaitingByProof(saved.proofHash, saved.sessionId, before))
      .resolves.toMatchObject({ stage: "awaiting_confirmation" });
    await expect(repository.findByReceipt(saved.localReceiptHash, before))
      .resolves.toMatchObject({ stage: "awaiting_confirmation" });
    await expect(repository.findAwaitingByProof(saved.proofHash, saved.sessionId, saved.freshUntil))
      .resolves.toBeNull();
    await expect(repository.findByReceipt(saved.localReceiptHash, saved.freshUntil))
      .resolves.toBeNull();
  });

  it("atomically accepts Core, scrubs identity linkage, and remains crash-recoverable by local receipt", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    const coreHash = Buffer.alloc(32, 7);
    const accepted = await repository.acceptCore(await confirmed(saved), processing, coreHash, "encrypted-core-receipt");

    expect(accepted).toMatchObject({
      stage: "local_recovery",
      status: "processing",
      localReceiptHash: saved.localReceiptHash,
      coreReceiptHash: coreHash,
      encryptedCoreReceipt: "encrypted-core-receipt",
    });
    expect(accepted).not.toHaveProperty("subjectDigest");
    expect(accepted).not.toHaveProperty("sessionId");
    expect(accepted).not.toHaveProperty("proofHash");
    expect(accepted).not.toHaveProperty("encryptedIdentityTokens");

    const persisted = await pool.query(
      `SELECT subject_digest, session_id, proof_hash, recovery_kind, recovery_ciphertext
         FROM account_deletion_intents WHERE id = $1`,
      [saved.id],
    );
    expect(persisted.rows[0]).toEqual({
      subject_digest: null,
      session_id: null,
      proof_hash: null,
      recovery_kind: "core_receipt",
      recovery_ciphertext: "encrypted-core-receipt",
    });
    const restartedRepository = new PostgresAccountDeletionRepository(pool);
    await expect(restartedRepository.findByReceipt(
      saved.localReceiptHash,
      new Date("2026-09-20T12:04:59.999Z"),
    )).resolves.toMatchObject({ stage: "local_recovery", id: saved.id });
  });

  it("confirms the Core capability by removing local recovery and rejects a mismatched Core hash", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    const accepted = await repository.acceptCore(
      await confirmed(saved),
      processing,
      Buffer.alloc(32, 7),
      "encrypted-core-receipt",
    );
    expect(accepted).not.toBeNull();
    if (!accepted) throw new Error("expected Core acceptance");

    await expect(repository.recordCoreReceiptStatus(
      { ...accepted, coreReceiptHash: Buffer.alloc(32, 8) },
      processing,
    )).resolves.toBeNull();
    await expect(repository.recordCoreReceiptStatus(accepted, processing)).resolves.toMatchObject({
      stage: "core_receipt",
      status: "processing",
    });
    await expect(repository.findByReceipt(
      saved.localReceiptHash,
      new Date("2026-09-20T12:03:00.000Z"),
    )).resolves.toBeNull();
    const persisted = await pool.query(
      "SELECT local_receipt_hash, recovery_kind, recovery_ciphertext FROM account_deletion_intents",
    );
    expect(persisted.rows[0]).toEqual({
      local_receipt_hash: null,
      recovery_kind: null,
      recovery_ciphertext: null,
    });
  });

  it("does not regress out-of-order status and keeps completion terminal", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    const accepted = await repository.acceptCore(
      await confirmed(saved),
      processing,
      Buffer.alloc(32, 9),
      "encrypted-core-receipt",
    );
    if (!accepted) throw new Error("expected Core acceptance");
    const manual = await repository.refreshLocalRecovery(accepted, {
      ...processing,
      status: "manual_intervention",
      updatedAt: "2026-09-20T12:00:04.000Z",
    }, "encrypted-core-receipt");
    if (!manual) throw new Error("expected manual intervention");
    await expect(repository.refreshLocalRecovery(manual, {
      ...processing,
      status: "pending",
      partial: false,
      updatedAt: "2026-09-20T12:00:03.000Z",
    }, "encrypted-core-receipt")).resolves.toMatchObject({
      status: "manual_intervention",
      partial: true,
      updatedAt: new Date("2026-09-20T12:00:04.000Z"),
    });
    const completed = await repository.recordCoreReceiptStatus(manual, {
      ...processing,
      status: "completed",
      partial: false,
      updatedAt: "2026-09-20T12:00:05.000Z",
      completedAt: "2026-09-20T12:00:05.000Z",
    });
    if (!completed) throw new Error("expected completion");
    await expect(repository.recordCoreReceiptStatus(completed, processing)).resolves.toMatchObject({
      stage: "core_receipt",
      status: "completed",
      partial: false,
      completedAt: new Date("2026-09-20T12:00:05.000Z"),
    });
  });

  it("lets an incoming completed win over a newer stored status", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    const accepted = await repository.acceptCore(
      await confirmed(saved),
      processing,
      Buffer.alloc(32, 9),
      "encrypted-core-receipt",
    );
    if (!accepted) throw new Error("expected Core acceptance");
    const manual = await repository.recordCoreReceiptStatus(accepted, {
      ...processing,
      status: "manual_intervention",
      updatedAt: "2026-09-20T12:00:04.000Z",
    });
    if (!manual) throw new Error("expected manual intervention");
    // Core never leaves completed, so its completion is the latest word even
    // when it carries an older updatedAt than the stored status.
    const completed = await repository.recordCoreReceiptStatus(manual, {
      ...processing,
      status: "completed",
      partial: false,
      updatedAt: "2026-09-20T12:00:03.000Z",
      completedAt: "2026-09-20T12:00:03.000Z",
    });
    expect(completed).toMatchObject({
      status: "completed",
      partial: false,
      completedAt: new Date("2026-09-20T12:00:03.000Z"),
      updatedAt: new Date("2026-09-20T12:00:04.000Z"),
    });
    if (!completed) throw new Error("expected completion");
    await expect(repository.recordCoreReceiptStatus(completed, {
      ...processing,
      status: "manual_intervention",
      updatedAt: "2026-09-20T12:00:09.000Z",
    })).resolves.toMatchObject({ status: "completed", completedAt: new Date("2026-09-20T12:00:03.000Z") });
  });

  // Ticket 13: an older core wrote the next attempt's time into updatedAt,
  // so a stored status could carry a future stamp.
  it("does not let a stored future updatedAt hide a newer status", async () => {
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    const receiptExpiresAt = at(30 * 24 * 60 * 60);
    const accept = async () => {
      await pool.query("TRUNCATE account_deletion_intents CASCADE");
      const saved = await repository.saveReauthentication(awaiting());
      const accepted = await repository.acceptCore(
        await confirmed(saved),
        processing,
        Buffer.alloc(32, 9),
        "encrypted-core-receipt",
      );
      if (!accepted) throw new Error("expected Core acceptance");
      // Manual intervention stamped with the next attempt, 30 s ahead.
      const manual = await repository.recordCoreReceiptStatus(accepted, {
        ...processing,
        status: "manual_intervention",
        updatedAt: at(30),
        receiptExpiresAt,
      });
      if (!manual) throw new Error("expected manual intervention");
      return manual;
    };

    // The person retried at once and core completed the request.
    const completedAt = at(-1);
    await expect(repository.recordCoreReceiptStatus(await accept(), {
      ...processing,
      status: "completed",
      partial: false,
      updatedAt: completedAt,
      completedAt,
      receiptExpiresAt,
    })).resolves.toMatchObject({
      status: "completed",
      partial: false,
      completedAt: new Date(completedAt),
      updatedAt: new Date(completedAt),
    });

    // The retry itself: pending replaces the stored status, and the stamp
    // becomes core's, so an out-of-order older read no longer wins.
    const retriedAt = at(-2);
    const retried = await repository.recordCoreReceiptStatus(await accept(), {
      ...processing,
      status: "pending",
      partial: true,
      updatedAt: retriedAt,
      receiptExpiresAt,
    });
    expect(retried).toMatchObject({ status: "pending", updatedAt: new Date(retriedAt) });
    if (!retried) throw new Error("expected the retry's status");
    await expect(repository.recordCoreReceiptStatus(retried, {
      ...processing,
      status: "manual_intervention",
      updatedAt: at(-3),
      receiptExpiresAt,
    })).resolves.toMatchObject({ status: "pending", updatedAt: new Date(retriedAt) });
  });

  it("rejects impossible persisted lifecycle combinations", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    await expect(pool.query(
      "UPDATE account_deletion_intents SET recovery_kind = NULL WHERE id = $1",
      [saved.id],
    )).rejects.toThrow(/check constraint/i);
    await pool.query("TRUNCATE account_deletion_intents CASCADE");
    const reloaded = await repository.saveReauthentication(awaiting());
    const accepted = await repository.acceptCore(
      await confirmed(reloaded),
      processing,
      Buffer.alloc(32, 7),
      "encrypted-core-receipt",
    );
    expect(accepted).not.toBeNull();
    await expect(pool.query(
      "UPDATE account_deletion_intents SET subject_digest = $2 WHERE id = $1",
      [saved.id, Buffer.alloc(32, 6)],
    )).rejects.toThrow(/check constraint/i);
  });

  // A7d: the local receipt reaches the browser at `prepare`, before the typed
  // confirmation, so the confirmation is its own durable record, bound to the
  // proof it was typed under, and core acceptance requires it.
  it("records a confirmation only for the current proof, session and receipt inside the window", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    const inWindow = new Date("2026-09-20T12:04:00.000Z");
    await expect(repository.findByReceipt(saved.localReceiptHash, inWindow))
      .resolves.toMatchObject({ stage: "awaiting_confirmation", confirmedAt: null });

    for (const stranger of [
      { ...saved, proofHash: Buffer.alloc(32, 9) },
      { ...saved, sessionId: "33333333-3333-4333-8333-333333333333" },
      { ...saved, localReceiptHash: Buffer.alloc(32, 9) },
    ]) {
      await expect(repository.confirm(stranger, confirmedAt)).resolves.toBeNull();
    }
    await expect(repository.confirm(saved, saved.freshUntil)).resolves.toBeNull();
    await expect(repository.findByReceipt(saved.localReceiptHash, inWindow))
      .resolves.toMatchObject({ confirmedAt: null });

    await expect(repository.confirm(saved, confirmedAt))
      .resolves.toMatchObject({ id: saved.id, confirmedAt });
    // A second submit keeps the first confirmation time.
    await expect(repository.confirm(saved, new Date("2026-09-20T12:02:00.000Z")))
      .resolves.toMatchObject({ confirmedAt });
    await expect(repository.findByReceipt(saved.localReceiptHash, inWindow))
      .resolves.toMatchObject({ stage: "awaiting_confirmation", confirmedAt });
    await expect(repository.findAwaitingByProof(saved.proofHash, saved.sessionId, inWindow))
      .resolves.toMatchObject({ confirmedAt });
  });

  it("voids a confirmation on re-authentication, on withdrawal and with its intent", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    await confirmed(saved);
    const resealed = await repository.saveReauthentication(awaiting({
      proofHash: Buffer.alloc(32, 4),
      localReceiptHash: Buffer.alloc(32, 5),
      updatedAt: new Date("2026-09-20T12:02:00.000Z"),
    }));
    const inWindow = new Date("2026-09-20T12:04:00.000Z");
    await expect(repository.findByReceipt(resealed.localReceiptHash, inWindow))
      .resolves.toMatchObject({ confirmedAt: null });
    await expect(repository.acceptCore(resealed, processing, Buffer.alloc(32, 7), "encrypted"))
      .resolves.toBeNull();

    await confirmed(resealed);
    await repository.withdrawConfirmation(saved);
    await expect(repository.findByReceipt(resealed.localReceiptHash, inWindow))
      .resolves.toMatchObject({ confirmedAt });
    await repository.withdrawConfirmation(resealed);
    await expect(repository.findByReceipt(resealed.localReceiptHash, inWindow))
      .resolves.toMatchObject({ confirmedAt: null });

    await confirmed(resealed);
    await pool.query("DELETE FROM account_deletion_intents WHERE id = $1", [resealed.id]);
    await expect(pool.query("SELECT count(*)::integer AS count FROM account_deletion_confirmations"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("accepts core only for a confirmed intent and scrubs the confirmation with the proof", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    await expect(repository.acceptCore(saved, processing, Buffer.alloc(32, 7), "encrypted"))
      .resolves.toBeNull();
    await expect(repository.acceptCore(await confirmed(saved), processing, Buffer.alloc(32, 7), "encrypted"))
      .resolves.toMatchObject({ stage: "local_recovery" });
    await expect(pool.query("SELECT count(*)::integer AS count FROM account_deletion_confirmations"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  // An intent an older build sealed before 0007 has no confirmation: it
  // stays readable, reads as unconfirmed and can never be accepted.
  it("treats an intent sealed before the confirmation migration as unconfirmed", async () => {
    await inFreshSchema(async (schemaPool) => {
      await schemaPool.query(migration);
      const old = awaiting();
      await schemaPool.query(
        `INSERT INTO account_deletion_intents
           (id, subject_digest, session_id, proof_hash, local_receipt_hash,
            core_receipt_hash, recovery_kind, recovery_ciphertext, status, partial,
            requested_at, completed_at, receipt_expires_at, fresh_until, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NULL, 'identity_tokens', $6, 'awaiting_confirmation', false,
                 NULL, NULL, NULL, $7, $8, $9)`,
        [
          old.id, old.subjectDigest, old.sessionId, old.proofHash, old.localReceiptHash,
          old.encryptedIdentityTokens, old.freshUntil, old.createdAt, old.updatedAt,
        ],
      );
      await schemaPool.query(confirmationMigration);
      await schemaPool.query(confirmationMigration);

      const upgraded = new PostgresAccountDeletionRepository(schemaPool);
      const inFlight = await upgraded.findByReceipt(old.localReceiptHash, new Date("2026-09-20T12:04:00.000Z"));
      expect(inFlight).toMatchObject({ stage: "awaiting_confirmation", id: old.id, confirmedAt: null });
      if (inFlight?.stage !== "awaiting_confirmation") throw new Error("expected the old intent");
      await expect(upgraded.acceptCore(inFlight, processing, Buffer.alloc(32, 7), "encrypted"))
        .resolves.toBeNull();
      // The intent table itself is unchanged: 0005 still recognises it.
      await expect(schemaPool.query(migration)).resolves.toBeDefined();
    });
  });

  it("fails the confirmation migration closed for any drift of its table", async () => {
    await inFreshSchema(async (schemaPool) => {
      await schemaPool.query(migration);
      await schemaPool.query(confirmationMigration);
      await schemaPool.query("ALTER TABLE account_deletion_confirmations ADD COLUMN raw_proof text");
      await expect(schemaPool.query(confirmationMigration)).rejects.toThrow(/unexpected column fingerprint/i);
    });
  });

  it("fails brownfield migration closed for any column definition drift", async () => {
    await expectFingerprintFailure(
      "ALTER TABLE account_deletion_intents ALTER COLUMN partial DROP DEFAULT",
      /unexpected column fingerprint/i,
    );
    await expectFingerprintFailure(
      "ALTER TABLE account_deletion_intents ALTER COLUMN requested_at SET NOT NULL",
      /unexpected column fingerprint/i,
    );
    await expectFingerprintFailure(
      "ALTER TABLE account_deletion_intents ALTER COLUMN recovery_ciphertext TYPE varchar(1024)",
      /unexpected column fingerprint/i,
    );
    await expectFingerprintFailure(
      "ALTER TABLE account_deletion_intents ADD COLUMN raw_receipt text",
      /unexpected column fingerprint/i,
    );
  });

  it("fails brownfield migration closed for any constraint-set drift", async () => {
    await expectFingerprintFailure(
      "ALTER TABLE account_deletion_intents ADD CONSTRAINT unexpected_check CHECK (created_at IS NOT NULL)",
      /unexpected constraint fingerprint/i,
    );
  });

  it("fails brownfield migration closed for any index-definition drift", async () => {
    await expectFingerprintFailure(
      `DROP INDEX account_deletion_intents_fresh_expiry_idx;
       CREATE INDEX account_deletion_intents_fresh_expiry_idx
         ON account_deletion_intents (created_at)
         WHERE status = 'awaiting_confirmation'`,
      /unexpected index fingerprint/i,
    );
  });
});
