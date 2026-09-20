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

function awaiting(overrides: Partial<AwaitingConfirmationIntent> = {}): AwaitingConfirmationIntent {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    stage: "awaiting_confirmation",
    subjectDigest: Buffer.alloc(32, 1),
    sessionId: "11111111-1111-4111-8111-111111111111",
    proofHash: Buffer.alloc(32, 2),
    localReceiptHash: Buffer.alloc(32, 3),
    encryptedIdentityTokens: "encrypted-fresh-token",
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
  let fingerprintSequence = 0;

  beforeAll(async () => {
    migration = await readFile(migrationPath, "utf8");
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(migration);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE account_deletion_intents");
  });

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
    const accepted = await repository.acceptCore(saved, processing, coreHash, "encrypted-core-receipt");

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
      saved,
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
      saved,
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

  it("rejects impossible persisted lifecycle combinations", async () => {
    const saved = await repository.saveReauthentication(awaiting());
    await expect(pool.query(
      "UPDATE account_deletion_intents SET recovery_kind = NULL WHERE id = $1",
      [saved.id],
    )).rejects.toThrow(/check constraint/i);
    await pool.query("TRUNCATE account_deletion_intents");
    const reloaded = await repository.saveReauthentication(awaiting());
    const accepted = await repository.acceptCore(
      reloaded,
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
