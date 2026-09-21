// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import { PostgresSessionRepository, PostgresSudoRepository } from "@/server/auth/postgres-repositories";
import { SudoRequiredError, SudoSessionInactiveError, SudoVault } from "@/server/auth/sudo";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const migrations = [
  "0001_bff_web_sessions.sql",
  "0002_auth_security_controls.sql",
  "0003_native_handoff.sql",
  "0004_account_action_results.sql",
  "0005_account_deletion_intents.sql",
  "0006_account_sudo.sql",
];
const sudoToken = "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyJ9.integration-signature";

databaseDescribe("PostgreSQL sudo storage", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const sessions = new PostgresSessionRepository(pool);
  const repository = new PostgresSudoRepository(pool);
  const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 11));
  const now = new Date("2026-09-21T13:10:18.000Z");
  let current = now;
  const vault = new SudoVault(repository, cipher, () => current);
  const sessionId = "33333333-3333-4333-8333-333333333333";

  async function seedSession(id = sessionId, handle = 33) {
    await sessions.insert({
      id,
      subject: `sudo-user-${handle}`,
      keycloakSid: `sudo-sid-${handle}`,
      handleHash: Buffer.alloc(32, handle),
      tokenCiphertext: "encrypted-tokens",
      createdAt: now,
      rotatedAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date("2026-09-21T13:40:18.000Z"),
      absoluteExpiresAt: new Date("2026-09-21T21:10:18.000Z"),
    });
  }

  beforeAll(async () => {
    for (const migration of migrations) {
      await pool.query(await readFile(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
  });

  beforeEach(async () => {
    current = now;
    await pool.query("TRUNCATE account_sessions CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies the sudo migration idempotently on top of the live schema", async () => {
    await pool.query(await readFile(resolve(process.cwd(), "migrations", "0006_account_sudo.sql"), "utf8"));
    const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'account_sessions'
          AND column_name IN ('sudo_token_ciphertext', 'sudo_expires_at')
        ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "sudo_expires_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "sudo_token_ciphertext", data_type: "text", is_nullable: "YES" },
    ]);
  });

  it("stores encrypted sudo material on the active session and reads it back once fresh", async () => {
    await seedSession();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));

    const row = await pool.query<{ sudo_token_ciphertext: string; sudo_expires_at: Date; token_ciphertext: string }>(
      "SELECT sudo_token_ciphertext, sudo_expires_at, token_ciphertext FROM account_sessions WHERE id = $1",
      [sessionId],
    );
    expect(row.rows[0]?.sudo_expires_at).toEqual(new Date("2026-09-21T13:15:18.000Z"));
    expect(typeof row.rows[0]?.sudo_token_ciphertext).toBe("string");
    expect(row.rows[0]?.sudo_token_ciphertext).not.toContain(sudoToken);
    expect(JSON.parse(row.rows[0]!.sudo_token_ciphertext)).toMatchObject({ v: 1 });
    expect(row.rows[0]?.token_ciphertext).toBe("encrypted-tokens");

    await expect(vault.requireFreshSudo(sessionId)).resolves.toBe(sudoToken);
    current = new Date("2026-09-21T13:15:14.000Z");
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "expired" });
    const scrubbed = await pool.query<{ sudo_token_ciphertext: string | null; sudo_expires_at: Date | null }>(
      "SELECT sudo_token_ciphertext, sudo_expires_at FROM account_sessions WHERE id = $1",
      [sessionId],
    );
    expect(scrubbed.rows[0]).toEqual({ sudo_token_ciphertext: null, sudo_expires_at: null });
  });

  it("replaces an earlier proof and clears it on demand", async () => {
    await seedSession();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    const replacement = "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyIsImp0aSI6IjIifQ.second-signature";
    await vault.storeSudo(sessionId, replacement, new Date("2026-09-21T13:14:00.000Z"));
    await expect(vault.requireFreshSudo(sessionId)).resolves.toBe(replacement);
    await vault.clearSudo(sessionId);
    await expect(vault.requireFreshSudo(sessionId)).rejects.toBeInstanceOf(SudoRequiredError);
  });

  it("refuses to store or serve sudo material for revoked, expired, or unknown sessions", async () => {
    await seedSession();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    await sessions.revokeById(sessionId, current);
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });
    await expect(vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z")))
      .rejects.toBeInstanceOf(SudoSessionInactiveError);

    await pool.query("TRUNCATE account_sessions CASCADE");
    await seedSession();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    await pool.query("UPDATE account_sessions SET idle_expires_at = $2 WHERE id = $1", [sessionId, new Date("2026-09-21T13:12:00.000Z")]);
    current = new Date("2026-09-21T13:12:30.000Z");
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });

    await expect(vault.storeSudo("44444444-4444-4444-8444-444444444444", sudoToken, new Date("2026-09-21T13:15:18.000Z")))
      .rejects.toBeInstanceOf(SudoSessionInactiveError);
  });

  it("binds the ciphertext to its own session record", async () => {
    const otherSessionId = "55555555-5555-4555-8555-555555555555";
    await seedSession();
    await seedSession(otherSessionId, 55);
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    await pool.query(
      `UPDATE account_sessions AS target
          SET sudo_token_ciphertext = source.sudo_token_ciphertext,
              sudo_expires_at = source.sudo_expires_at
         FROM account_sessions AS source
        WHERE source.id = $1 AND target.id = $2`,
      [sessionId, otherSessionId],
    );
    await expect(vault.requireFreshSudo(otherSessionId)).rejects.toMatchObject({ reason: "missing" });
    await expect(vault.requireFreshSudo(sessionId)).resolves.toBe(sudoToken);
  });

  it("enforces the paired-column and size constraints at the database", async () => {
    await seedSession();
    await expect(pool.query(
      "UPDATE account_sessions SET sudo_expires_at = now() WHERE id = $1",
      [sessionId],
    )).rejects.toThrow(/account_sessions_sudo_pair_check/);
    await expect(pool.query(
      "UPDATE account_sessions SET sudo_token_ciphertext = $2, sudo_expires_at = now() WHERE id = $1",
      [sessionId, ""],
    )).rejects.toThrow(/account_sessions_sudo_ciphertext_length_check/);
    await expect(pool.query(
      "UPDATE account_sessions SET sudo_token_ciphertext = $2, sudo_expires_at = now() WHERE id = $1",
      [sessionId, "x".repeat(16_385)],
    )).rejects.toThrow(/account_sessions_sudo_ciphertext_length_check/);
  });

  it("drops the sudo material together with the session row", async () => {
    await seedSession();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    await expect(sessions.deleteByIdReturningToken(sessionId)).resolves.toBe("encrypted-tokens");
    await expect(repository.readSudo(sessionId, current)).resolves.toBeNull();
  });
});
