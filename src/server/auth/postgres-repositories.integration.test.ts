import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAccountActionResultRepository,
  PostgresBackchannelLogoutRepository,
  PostgresNativeHandoffRepository,
  PostgresOidcTransactionRepository,
  PostgresRateLimitRepository,
  PostgresSessionRepository,
} from "@/server/auth/postgres-repositories";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe("PostgreSQL authentication repositories", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  beforeAll(async () => {
    for (const migrationName of [
      "0001_bff_web_sessions.sql",
      "0002_auth_security_controls.sql",
      "0003_native_handoff.sql",
      "0004_account_action_results.sql",
    ]) {
      const migration = await readFile(resolve(process.cwd(), "migrations", migrationName), "utf8");
      await pool.query(migration);
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE account_oidc_transactions, account_action_results, account_sessions, account_backchannel_logout_replays, account_auth_rate_limits, account_native_handoffs, account_native_bridges, account_native_bridge_request_nonces",
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

  it("reads an action result without loss, then atomically acknowledges it once", async () => {
    const sessionRepository = new PostgresSessionRepository(pool);
    const sessionId = "89898989-8989-4989-8989-898989898989";
    await sessionRepository.insert({
      id: sessionId,
      subject: "action-result-user",
      keycloakSid: "action-result-sid",
      handleHash: Buffer.alloc(32, 70),
      tokenCiphertext: "encrypted",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      rotatedAt: new Date("2026-09-20T00:00:00Z"),
      lastSeenAt: new Date("2026-09-20T00:00:00Z"),
      idleExpiresAt: new Date("2026-09-20T00:30:00Z"),
      absoluteExpiresAt: new Date("2026-09-20T08:00:00Z"),
    });
    const repository = new PostgresAccountActionResultRepository(pool);
    const resultHash = Buffer.alloc(32, 71);
    await repository.insert({
      resultHash,
      sessionId,
      action: "otp",
      outcome: "success",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      expiresAt: new Date("2026-09-20T00:05:00Z"),
    });

    await expect(repository.read(
      resultHash,
      "79797979-7979-4979-8979-797979797979",
      new Date("2026-09-20T00:01:00Z"),
    )).resolves.toBeNull();
    await expect(repository.read(
      resultHash,
      sessionId,
      new Date("2026-09-20T00:01:00Z"),
    )).resolves.toEqual({ action: "otp", outcome: "success" });
    await expect(repository.read(
      resultHash,
      sessionId,
      new Date("2026-09-20T00:01:00Z"),
    )).resolves.toEqual({ action: "otp", outcome: "success" });
    const outcomes = await Promise.all([
      repository.consume(resultHash, sessionId, new Date("2026-09-20T00:01:00Z")),
      repository.consume(resultHash, sessionId, new Date("2026-09-20T00:01:00Z")),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes.find(Boolean)).toEqual({ action: "otp", outcome: "success" });
    await expect(repository.read(
      resultHash,
      sessionId,
      new Date("2026-09-20T00:01:00Z"),
    )).resolves.toBeNull();
  });

  it("rotates a still-valid previous handle so a lost Set-Cookie response can recover", async () => {
    const repository = new PostgresSessionRepository(pool);
    const now = new Date("2026-09-20T00:20:00Z");
    const original = Buffer.alloc(32, 21);
    const firstReplacement = Buffer.alloc(32, 22);
    const recoveryReplacement = Buffer.alloc(32, 23);
    await repository.insert({
      id: "88888888-8888-4888-8888-888888888888",
      subject: "rotation-recovery",
      keycloakSid: "rotation-recovery-sid",
      handleHash: original,
      tokenCiphertext: "encrypted",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      rotatedAt: new Date("2026-09-20T00:00:00Z"),
      lastSeenAt: new Date("2026-09-20T00:00:00Z"),
      idleExpiresAt: new Date("2026-09-20T00:30:00Z"),
      absoluteExpiresAt: new Date("2026-09-20T08:00:00Z"),
    });

    const first = await repository.useHandle({
      handleHash: original,
      replacementHandleHash: firstReplacement,
      now,
      idleTtlSeconds: 1_800,
      rotateAfterSeconds: 900,
      previousHandleGraceSeconds: 30,
      allowRotation: true,
    });
    expect(first).toMatchObject({ rotated: true });

    const recovery = await repository.useHandle({
      handleHash: original,
      replacementHandleHash: recoveryReplacement,
      now: new Date("2026-09-20T00:20:01Z"),
      idleTtlSeconds: 1_800,
      rotateAfterSeconds: 900,
      previousHandleGraceSeconds: 30,
      allowRotation: true,
    });
    expect(recovery).toMatchObject({ rotated: true });

    await expect(repository.useHandle({
      handleHash: firstReplacement,
      replacementHandleHash: Buffer.alloc(32, 24),
      now: new Date("2026-09-20T00:20:02Z"),
      idleTtlSeconds: 1_800,
      rotateAfterSeconds: 900,
      previousHandleGraceSeconds: 30,
      allowRotation: false,
    })).resolves.not.toBeNull();
    await expect(repository.useHandle({
      handleHash: recoveryReplacement,
      replacementHandleHash: Buffer.alloc(32, 25),
      now: new Date("2026-09-20T00:20:02Z"),
      idleTtlSeconds: 1_800,
      rotateAfterSeconds: 900,
      previousHandleGraceSeconds: 30,
      allowRotation: false,
    })).resolves.not.toBeNull();
  });

  it("resolves a candidate without touching it and revokes every session for a blocked subject", async () => {
    const repository = new PostgresSessionRepository(pool);
    const handle = Buffer.alloc(32, 61);
    const originalLastSeen = new Date("2026-09-20T00:05:00Z");
    await repository.insert({
      id: "61616161-6161-4616-8616-616161616161",
      subject: "blocked-subject",
      keycloakSid: "blocked-sid-one",
      handleHash: handle,
      tokenCiphertext: "encrypted-one",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      rotatedAt: new Date("2026-09-20T00:00:00Z"),
      lastSeenAt: originalLastSeen,
      idleExpiresAt: new Date("2026-09-20T00:30:00Z"),
      absoluteExpiresAt: new Date("2026-09-20T08:00:00Z"),
    });
    await repository.insert({
      id: "62626262-6262-4626-8626-626262626262",
      subject: "blocked-subject",
      keycloakSid: "blocked-sid-two",
      handleHash: Buffer.alloc(32, 62),
      tokenCiphertext: "encrypted-two",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      rotatedAt: new Date("2026-09-20T00:00:00Z"),
      lastSeenAt: originalLastSeen,
      idleExpiresAt: new Date("2026-09-20T00:30:00Z"),
      absoluteExpiresAt: new Date("2026-09-20T08:00:00Z"),
    });

    await expect(repository.findByHandle(
      handle,
      new Date("2026-09-20T00:10:00Z"),
    )).resolves.toMatchObject({ subject: "blocked-subject", lastSeenAt: originalLastSeen });
    const before = await pool.query(
      "SELECT last_seen_at, idle_expires_at FROM account_sessions WHERE id = $1",
      ["61616161-6161-4616-8616-616161616161"],
    );
    expect(before.rows[0]?.last_seen_at).toEqual(originalLastSeen);
    expect(before.rows[0]?.idle_expires_at).toEqual(new Date("2026-09-20T00:30:00Z"));

    await expect(repository.revokeBySubject(
      "blocked-subject",
      new Date("2026-09-20T00:10:01Z"),
    )).resolves.toBe(2);
    const revoked = await pool.query(
      "SELECT count(*)::int AS count FROM account_sessions WHERE subject = $1 AND revoked_at IS NOT NULL",
      ["blocked-subject"],
    );
    expect(revoked.rows[0]?.count).toBe(2);
  });

  it("compare-and-swaps token ciphertext only for an active matching session", async () => {
    const repository = new PostgresSessionRepository(pool);
    const now = new Date("2026-09-20T00:20:00Z");
    await repository.insert({
      id: "99999999-9999-4999-8999-999999999999",
      subject: "token-refresh-user",
      keycloakSid: "token-refresh-sid",
      handleHash: Buffer.alloc(32, 26),
      tokenCiphertext: "encrypted-v1",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      rotatedAt: new Date("2026-09-20T00:00:00Z"),
      lastSeenAt: now,
      idleExpiresAt: new Date("2026-09-20T00:30:00Z"),
      absoluteExpiresAt: new Date("2026-09-20T08:00:00Z"),
    });
    await expect(repository.getTokenCiphertext(
      "99999999-9999-4999-8999-999999999999",
      now,
    )).resolves.toBe("encrypted-v1");
    await expect(repository.replaceTokenCiphertext(
      "99999999-9999-4999-8999-999999999999",
      "stale",
      "encrypted-v2",
      undefined,
      now,
    )).resolves.toBe(false);
    await expect(repository.replaceTokenCiphertext(
      "99999999-9999-4999-8999-999999999999",
      "encrypted-v1",
      "encrypted-v2",
      undefined,
      now,
    )).resolves.toBe(true);
    await repository.revokeById("99999999-9999-4999-8999-999999999999", now);
    await expect(repository.getTokenCiphertext(
      "99999999-9999-4999-8999-999999999999",
      now,
    )).resolves.toBeNull();
  });

  it("atomically updates the token set and Keycloak sid for sid-only logout", async () => {
    const sessions = new PostgresSessionRepository(pool);
    const now = new Date("2026-09-20T00:20:00Z");
    const sessionId = "98989898-9898-4989-8989-989898989898";
    await sessions.insert({
      id: sessionId,
      subject: "sid-rotation-user",
      keycloakSid: "old-upstream-sid",
      handleHash: Buffer.alloc(32, 72),
      tokenCiphertext: "encrypted-v1",
      createdAt: new Date("2026-09-20T00:00:00Z"),
      rotatedAt: new Date("2026-09-20T00:00:00Z"),
      lastSeenAt: now,
      idleExpiresAt: new Date("2026-09-20T00:30:00Z"),
      absoluteExpiresAt: new Date("2026-09-20T08:00:00Z"),
    });

    await expect(sessions.replaceTokenCiphertext(
      sessionId,
      "encrypted-v1",
      "encrypted-v2",
      "new-upstream-sid",
      now,
    )).resolves.toBe(true);
    await expect(pool.query(
      "SELECT keycloak_sid, token_ciphertext FROM account_sessions WHERE id = $1",
      [sessionId],
    )).resolves.toMatchObject({
      rows: [{ keycloak_sid: "new-upstream-sid", token_ciphertext: "encrypted-v2" }],
    });

    const logout = new PostgresBackchannelLogoutRepository(pool);
    await expect(logout.consumeAndDeleteSessions({
      jtiHash: Buffer.alloc(32, 73),
      seenAt: now,
      replayExpiresAt: new Date("2026-09-20T00:30:00Z"),
      keycloakSid: "new-upstream-sid",
    })).resolves.toEqual({ accepted: true, deletedSessions: 1 });
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
      `INSERT INTO account_native_handoffs
        (id, code_hash, subject, keycloak_sid, authenticated_at, created_at, expires_at, consumed_at)
       VALUES
        ('12121212-1212-4212-8212-121212121212', $1, 'old-native', 'old-sid', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours', now() - interval '2 hours'),
        ('13131313-1313-4313-8313-131313131313', $2, 'fresh-native', 'fresh-sid', now(), now(), now() + interval '45 seconds', NULL)`,
      [Buffer.alloc(32, 50), Buffer.alloc(32, 51)],
    );
    await pool.query(
      `INSERT INTO account_native_bridges
        (id, code_hash, subject, keycloak_sid, authenticated_at, created_at, expires_at, consumed_at)
       VALUES
        ('14141414-1414-4414-8414-141414141414', $1, 'old-native', 'old-sid', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours', now() - interval '2 hours'),
        ('15151515-1515-4515-8515-151515151515', $2, 'fresh-native', 'fresh-sid', now(), now(), now() + interval '45 seconds', NULL)`,
      [Buffer.alloc(32, 52), Buffer.alloc(32, 53)],
    );
    await pool.query(
      `INSERT INTO account_native_bridge_request_nonces (nonce_hash, seen_at, expires_at)
       VALUES ($1, now() - interval '2 minutes', now() - interval '1 minute'),
              ($2, now(), now() + interval '1 minute')`,
      [Buffer.alloc(32, 54), Buffer.alloc(32, 55)],
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
    await pool.query(
      `INSERT INTO account_action_results
        (result_hash, session_id, action, outcome, created_at, expires_at, consumed_at)
       VALUES
        ($1, '77777777-7777-4777-8777-777777777777', 'otp', 'success', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour'),
        ($2, '77777777-7777-4777-8777-777777777777', 'passkey', 'cancelled', now(), now() + interval '5 minutes', NULL)`,
      [Buffer.alloc(32, 74), Buffer.alloc(32, 75)],
    );
    const maintenance = await readFile(resolve(process.cwd(), "maintenance/prune-auth.sql"), "utf8");
    const result = await pool.query(maintenance);
    expect(result.rows[0]?.deleted_transactions).toBe(1);
    expect(result.rows[0]?.deleted_sessions).toBe(2);
    expect(result.rows[0]?.deleted_logout_replays).toBe(1);
    expect(result.rows[0]?.deleted_rate_limits).toBe(1);
    expect(result.rows[0]?.deleted_native_handoffs).toBe(1);
    expect(result.rows[0]?.deleted_native_bridges).toBe(1);
    expect(result.rows[0]?.deleted_native_bridge_nonces).toBe(1);
    expect(result.rows[0]?.deleted_action_results).toBe(1);
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
    const remainingActionResults = await pool.query(
      "SELECT action, outcome FROM account_action_results",
    );
    expect(remainingActionResults.rows).toEqual([{ action: "passkey", outcome: "cancelled" }]);
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

  it("atomically exchanges and redeems native handoffs under concurrent replay", async () => {
    const repository = new PostgresNativeHandoffRepository(pool);
    const now = new Date("2026-09-20T12:00:00Z");
    await repository.insert({
      id: "99999999-9999-4999-8999-999999999999",
      codeHash: Buffer.alloc(32, 30),
      subject: "native-user",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
      createdAt: now,
      expiresAt: new Date("2026-09-20T12:00:45Z"),
    });

    const exchanges = await Promise.all([
      repository.consumeAndCreateBridge({
        publicCodeHash: Buffer.alloc(32, 30),
        bridgeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        bridgeCodeHash: Buffer.alloc(32, 31),
        now: new Date("2026-09-20T12:00:01Z"),
        bridgeExpiresAt: new Date("2026-09-20T12:00:46Z"),
      }),
      repository.consumeAndCreateBridge({
        publicCodeHash: Buffer.alloc(32, 30),
        bridgeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        bridgeCodeHash: Buffer.alloc(32, 32),
        now: new Date("2026-09-20T12:00:01Z"),
        bridgeExpiresAt: new Date("2026-09-20T12:00:46Z"),
      }),
    ]);
    expect(exchanges.filter(Boolean)).toHaveLength(1);
    expect(exchanges.find(Boolean)).toEqual({
      subject: "native-user",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
    });
    const winningBridgeHash = exchanges[0] ? Buffer.alloc(32, 31) : Buffer.alloc(32, 32);

    const redemptions = await Promise.all([
      repository.redeemBridge({
        bridgeCodeHash: winningBridgeHash,
        requestNonceHash: Buffer.alloc(32, 33),
        now: new Date("2026-09-20T12:00:02Z"),
        requestNonceExpiresAt: new Date("2026-09-20T12:01:02Z"),
      }),
      repository.redeemBridge({
        bridgeCodeHash: winningBridgeHash,
        requestNonceHash: Buffer.alloc(32, 34),
        now: new Date("2026-09-20T12:00:02Z"),
        requestNonceExpiresAt: new Date("2026-09-20T12:01:02Z"),
      }),
    ]);
    expect(redemptions.filter(Boolean)).toHaveLength(1);
    expect(redemptions.find(Boolean)).toEqual({
      subject: "native-user",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
    });
    const stored = await pool.query(
      "SELECT octet_length(code_hash) AS hash_bytes FROM account_native_handoffs UNION ALL SELECT octet_length(code_hash) FROM account_native_bridges",
    );
    expect(stored.rows).toEqual([{ hash_bytes: 32 }, { hash_bytes: 32 }]);
  });

  it("rejects expired codes and persists request nonces even when bridge lookup fails", async () => {
    const repository = new PostgresNativeHandoffRepository(pool);
    await repository.insert({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      codeHash: Buffer.alloc(32, 40),
      subject: "native-user",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
      createdAt: new Date("2026-09-20T12:00:00Z"),
      expiresAt: new Date("2026-09-20T12:00:45Z"),
    });
    await expect(repository.consumeAndCreateBridge({
      publicCodeHash: Buffer.alloc(32, 40),
      bridgeId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      bridgeCodeHash: Buffer.alloc(32, 41),
      now: new Date("2026-09-20T12:00:45Z"),
      bridgeExpiresAt: new Date("2026-09-20T12:01:30Z"),
    })).resolves.toBeNull();

    await repository.insert({
      id: "abababab-abab-4bab-8bab-abababababab",
      codeHash: Buffer.alloc(32, 43),
      subject: "native-user",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
      createdAt: new Date("2026-09-20T12:00:00Z"),
      expiresAt: new Date("2026-09-20T12:00:45Z"),
    });
    await expect(repository.consumeAndCreateBridge({
      publicCodeHash: Buffer.alloc(32, 43),
      bridgeId: "acacacac-acac-4cac-8cac-acacacacacac",
      bridgeCodeHash: Buffer.alloc(32, 44),
      now: new Date("2026-09-20T12:00:01Z"),
      bridgeExpiresAt: new Date("2026-09-20T12:00:45Z"),
    })).resolves.not.toBeNull();

    await expect(repository.redeemBridge({
      bridgeCodeHash: Buffer.alloc(32, 99),
      requestNonceHash: Buffer.alloc(32, 42),
      now: new Date("2026-09-20T12:00:10Z"),
      requestNonceExpiresAt: new Date("2026-09-20T12:01:10Z"),
    })).resolves.toBeNull();
    await expect(repository.redeemBridge({
      bridgeCodeHash: Buffer.alloc(32, 44),
      requestNonceHash: Buffer.alloc(32, 42),
      now: new Date("2026-09-20T12:00:11Z"),
      requestNonceExpiresAt: new Date("2026-09-20T12:01:11Z"),
    })).resolves.toBeNull();
    await expect(repository.redeemBridge({
      bridgeCodeHash: Buffer.alloc(32, 44),
      requestNonceHash: Buffer.alloc(32, 45),
      now: new Date("2026-09-20T12:00:12Z"),
      requestNonceExpiresAt: new Date("2026-09-20T12:01:12Z"),
    })).resolves.toMatchObject({ subject: "native-user" });
    await repository.insert({
      id: "adadadad-adad-4dad-8dad-adadadadadad",
      codeHash: Buffer.alloc(32, 46),
      subject: "native-user",
      keycloakSid: "native-session",
      authenticatedAt: new Date("2026-09-20T11:45:00Z"),
      createdAt: new Date("2026-09-20T12:00:00Z"),
      expiresAt: new Date("2026-09-20T12:00:45Z"),
    });
    await repository.consumeAndCreateBridge({
      publicCodeHash: Buffer.alloc(32, 46),
      bridgeId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
      bridgeCodeHash: Buffer.alloc(32, 47),
      now: new Date("2026-09-20T12:00:01Z"),
      bridgeExpiresAt: new Date("2026-09-20T12:00:10Z"),
    });
    await expect(repository.redeemBridge({
      bridgeCodeHash: Buffer.alloc(32, 47),
      requestNonceHash: Buffer.alloc(32, 48),
      now: new Date("2026-09-20T12:00:10Z"),
      requestNonceExpiresAt: new Date("2026-09-20T12:01:10Z"),
    })).resolves.toBeNull();
    const nonces = await pool.query(
      "SELECT count(*)::integer AS count FROM account_native_bridge_request_nonces WHERE nonce_hash = $1",
      [Buffer.alloc(32, 42)],
    );
    expect(nonces.rows).toEqual([{ count: 1 }]);
  });
});
