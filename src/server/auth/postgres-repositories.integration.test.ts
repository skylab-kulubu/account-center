import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresBackchannelLogoutRepository,
  PostgresOidcTransactionRepository,
  PostgresRateLimitRepository,
} from "@/server/auth/postgres-repositories";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe("PostgreSQL authentication repositories", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  beforeAll(async () => {
    for (const migrationName of [
      "0001_bff_web_sessions.sql",
      "0002_auth_security_controls.sql",
    ]) {
      const migration = await readFile(resolve(process.cwd(), "migrations", migrationName), "utf8");
      await pool.query(migration);
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE account_oidc_transactions, account_sessions, account_backchannel_logout_replays, account_auth_rate_limits",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("atomically consumes one matching browser-bound transaction", async () => {
    const repository = new PostgresOidcTransactionRepository(pool);
    const stateHash = Buffer.alloc(32, 1);
    const bindingHash = Buffer.alloc(32, 2);
    await repository.insert({
      id: "11111111-1111-4111-8111-111111111111",
      stateHash,
      browserBindingHash: bindingHash,
      payloadCiphertext: "encrypted",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      expiresAt: new Date("2026-09-20T00:05:00Z"),
    });

    await expect(
      repository.consume(stateHash, Buffer.alloc(32, 3), new Date("2026-09-20T00:00:30Z")),
    ).resolves.toBeNull();

    const [first, replay] = await Promise.all([
      repository.consume(stateHash, bindingHash, new Date("2026-09-20T00:00:30Z")),
      repository.consume(stateHash, bindingHash, new Date("2026-09-20T00:00:30Z")),
    ]);
    expect([first, replay].filter(Boolean)).toHaveLength(1);
    expect(first ?? replay).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      payloadCiphertext: "encrypted",
    });
  });

  it("hard-deletes only authentication material beyond the retention grace", async () => {
    await pool.query(
      `INSERT INTO account_oidc_transactions
        (id, state_hash, browser_binding_hash, payload_ciphertext, created_at, expires_at, consumed_at)
       VALUES
        ('22222222-2222-4222-8222-222222222222', $1, $2, 'old', now() - interval '3 hours', now() - interval '2 hours', now() - interval '2 hours'),
        ('33333333-3333-4333-8333-333333333333', $3, $4, 'recent', now(), now() + interval '5 minutes', NULL)`,
      [Buffer.alloc(32, 4), Buffer.alloc(32, 5), Buffer.alloc(32, 6), Buffer.alloc(32, 7)],
    );
    await pool.query(
      `INSERT INTO account_backchannel_logout_replays (jti_hash, seen_at, expires_at)
       VALUES ($1, now() - interval '2 hours', now() - interval '1 hour'),
              ($2, now(), now() + interval '10 minutes')`,
      [Buffer.alloc(32, 12), Buffer.alloc(32, 13)],
    );
    await pool.query(
      `INSERT INTO account_auth_rate_limits
        (key_hash, window_started_at, request_count, expires_at)
       VALUES ($1, now() - interval '2 minutes', 12, now() - interval '1 minute'),
              ($2, now(), 1, now() + interval '1 minute')`,
      [Buffer.alloc(32, 14), Buffer.alloc(32, 15)],
    );
    await pool.query(
      `INSERT INTO account_sessions
        (id, subject, handle_hash, token_ciphertext, created_at, rotated_at, last_seen_at,
         idle_expires_at, absolute_expires_at, revoked_at)
       VALUES
        ('44444444-4444-4444-8444-444444444444', 'revoked-old', $1, 'revoked-old-token',
         now() - interval '50 hours', now() - interval '50 hours', now() - interval '26 hours',
         now() + interval '1 hour', now() + interval '2 hours', now() - interval '25 hours'),
        ('55555555-5555-4555-8555-555555555555', 'expired-old', $2, 'expired-old-token',
         now() - interval '50 hours', now() - interval '50 hours', now() - interval '25 hours',
         now() - interval '25 hours', now() - interval '25 hours', NULL),
        ('66666666-6666-4666-8666-666666666666', 'expired-in-grace', $3, 'grace-token',
         now() - interval '31 hours', now() - interval '31 hours', now() - interval '23 hours',
         now() - interval '23 hours', now() - interval '23 hours', NULL),
        ('77777777-7777-4777-8777-777777777777', 'active', $4, 'active-token',
         now() - interval '1 hour', now() - interval '1 hour', now(),
         now() + interval '30 minutes', now() + interval '7 hours', NULL)`,
      [Buffer.alloc(32, 8), Buffer.alloc(32, 9), Buffer.alloc(32, 10), Buffer.alloc(32, 11)],
    );
    const maintenance = await readFile(resolve(process.cwd(), "maintenance/prune-auth.sql"), "utf8");
    const result = await pool.query(maintenance);
    expect(result.rows[0]?.deleted_transactions).toBe(1);
    expect(result.rows[0]?.deleted_sessions).toBe(2);
    expect(result.rows[0]?.deleted_logout_replays).toBe(1);
    expect(result.rows[0]?.deleted_rate_limits).toBe(1);
    const remainingTransactions = await pool.query(
      "SELECT payload_ciphertext FROM account_oidc_transactions",
    );
    expect(remainingTransactions.rows).toEqual([{ payload_ciphertext: "recent" }]);
    const remainingSessions = await pool.query(
      "SELECT token_ciphertext FROM account_sessions ORDER BY token_ciphertext",
    );
    expect(remainingSessions.rows).toEqual([
      { token_ciphertext: "active-token" },
      { token_ciphertext: "grace-token" },
    ]);
  });

  it("atomically consumes logout jti and hard-deletes matching sid sessions", async () => {
    await pool.query(
      `INSERT INTO account_sessions
        (id, subject, keycloak_sid, handle_hash, token_ciphertext, created_at, rotated_at,
         last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-one', 'sid-one', $1, 'secret-token',
         now(), now(), now(), now() + interval '30 minutes', now() + interval '8 hours'),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'user-one', 'sid-two', $2, 'other-token',
         now(), now(), now(), now() + interval '30 minutes', now() + interval '8 hours')`,
      [Buffer.alloc(32, 16), Buffer.alloc(32, 17)],
    );
    const repository = new PostgresBackchannelLogoutRepository(pool);
    const input = {
      jtiHash: Buffer.alloc(32, 18),
      seenAt: new Date(),
      replayExpiresAt: new Date(Date.now() + 10 * 60 * 1_000),
      keycloakSid: "sid-one",
      subject: "user-one",
    };
    const results = await Promise.all([
      repository.consumeAndDeleteSessions(input),
      repository.consumeAndDeleteSessions(input),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.reduce((sum, result) => sum + result.deletedSessions, 0)).toBe(1);
    const remaining = await pool.query("SELECT keycloak_sid, token_ciphertext FROM account_sessions");
    expect(remaining.rows).toEqual([{ keycloak_sid: "sid-two", token_ciphertext: "other-token" }]);
  });

  it("enforces a fixed-window limit atomically", async () => {
    const repository = new PostgresRateLimitRepository(pool);
    const input = {
      keyHash: Buffer.alloc(32, 19),
      windowStartedAt: new Date("2026-09-20T00:00:00Z"),
      windowExpiresAt: new Date("2026-09-20T00:01:00Z"),
      limit: 10,
    };
    const decisions = await Promise.all(
      Array.from({ length: 30 }, () => repository.consume(input)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(Math.max(...decisions.map((decision) => decision.count))).toBe(30);
  });
});
