import "server-only";

import type { Pool, PoolClient } from "pg";
import type {
  BackchannelLogoutInput,
  BackchannelLogoutRepository,
  ConsumeNativeHandoffInput,
  NativeHandoffRepository,
  OidcTransactionRepository,
  RateLimitInput,
  RateLimitRepository,
  RedeemNativeBridgeInput,
  SessionRepository,
  SessionUseOutcome,
  UseSessionInput,
} from "@/server/auth/repositories";
import type { ActiveSession, NewNativeHandoff, NewSessionRecord, StoredOidcTransaction } from "@/server/auth/types";

type SessionRow = {
  id: string;
  subject: string;
  keycloak_sid: string | null;
  handle_hash: Buffer;
  previous_handle_hash: Buffer | null;
  previous_handle_expires_at: Date | null;
  created_at: Date;
  rotated_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
};

function activeSession(row: SessionRow, lastSeenAt = row.last_seen_at, idleExpiresAt = row.idle_expires_at): ActiveSession {
  return {
    id: row.id,
    subject: row.subject,
    keycloakSid: row.keycloak_sid,
    createdAt: row.created_at,
    lastSeenAt,
    idleExpiresAt,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresOidcTransactionRepository implements OidcTransactionRepository {
  constructor(private readonly pool: Pool) {}

  async insert(value: StoredOidcTransaction) {
    await this.pool.query(
      `INSERT INTO account_oidc_transactions
        (id, state_hash, browser_binding_hash, payload_ciphertext, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [value.id, value.stateHash, value.browserBindingHash, value.payloadCiphertext, value.createdAt, value.expiresAt],
    );
  }

  async consume(stateHash: Buffer, browserBindingHash: Buffer, now: Date) {
    const result = await this.pool.query<{ id: string; payload_ciphertext: string }>(
      `UPDATE account_oidc_transactions
          SET consumed_at = $3
        WHERE state_hash = $1
          AND browser_binding_hash = $2
          AND consumed_at IS NULL
          AND expires_at > $3
      RETURNING id, payload_ciphertext`,
      [stateHash, browserBindingHash, now],
    );
    const row = result.rows[0];
    return row ? { id: row.id, payloadCiphertext: row.payload_ciphertext } : null;
  }
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly pool: Pool) {}

  async insert(value: NewSessionRecord) {
    await this.pool.query(
      `INSERT INTO account_sessions
        (id, subject, keycloak_sid, handle_hash, token_ciphertext, created_at, rotated_at,
         last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        value.id,
        value.subject,
        value.keycloakSid,
        value.handleHash,
        value.tokenCiphertext,
        value.createdAt,
        value.rotatedAt,
        value.lastSeenAt,
        value.idleExpiresAt,
        value.absoluteExpiresAt,
      ],
    );
  }

  async useHandle(input: UseSessionInput): Promise<SessionUseOutcome | null> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<SessionRow>(
        `SELECT id, subject, keycloak_sid, handle_hash, previous_handle_hash,
                previous_handle_expires_at, created_at, rotated_at, last_seen_at,
                idle_expires_at, absolute_expires_at, revoked_at
           FROM account_sessions
          WHERE handle_hash = $1 OR previous_handle_hash = $1
          FOR UPDATE`,
        [input.handleHash],
      );
      const row = selected.rows[0];
      if (!row || row.revoked_at) return null;

      if (row.absolute_expires_at <= input.now || row.idle_expires_at <= input.now) {
        await client.query(
          "UPDATE account_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1",
          [row.id, input.now],
        );
        return null;
      }

      const matchedCurrent = row.handle_hash.equals(input.handleHash);
      const matchedPrevious = row.previous_handle_hash?.equals(input.handleHash) ?? false;
      if (
        !matchedCurrent &&
        (!matchedPrevious || !row.previous_handle_expires_at || row.previous_handle_expires_at <= input.now)
      ) {
        return null;
      }

      if (input.authorizeSessionId && !input.authorizeSessionId(row.id)) {
        return { proofRejected: true };
      }

      // Re-rotate a valid previous handle so a client can recover when the
      // response carrying the first replacement cookie was lost or aborted.
      const rotationDue =
        input.allowRotation &&
        (matchedPrevious ||
          (matchedCurrent &&
            row.rotated_at.getTime() <= input.now.getTime() - input.rotateAfterSeconds * 1_000));
      const idleExpiresAt = new Date(
        Math.min(
          row.absolute_expires_at.getTime(),
          input.now.getTime() + input.idleTtlSeconds * 1_000,
        ),
      );

      if (rotationDue) {
        await client.query(
          `UPDATE account_sessions
              SET previous_handle_hash = handle_hash,
                  previous_handle_expires_at = $3,
                  handle_hash = $2,
                  rotated_at = $4,
                  last_seen_at = $4,
                  idle_expires_at = $5
            WHERE id = $1`,
          [
            row.id,
            input.replacementHandleHash,
            new Date(input.now.getTime() + input.previousHandleGraceSeconds * 1_000),
            input.now,
            idleExpiresAt,
          ],
        );
      } else {
        await client.query(
          `UPDATE account_sessions
              SET last_seen_at = $2,
                  idle_expires_at = $3
            WHERE id = $1`,
          [row.id, input.now, idleExpiresAt],
        );
      }

      return {
        session: activeSession(row, input.now, idleExpiresAt),
        rotated: rotationDue,
      };
    });
  }

  async revokeByHandle(handleHash: Buffer, revokedAt: Date) {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
        WHERE (handle_hash = $1 OR previous_handle_hash = $1)
          AND revoked_at IS NULL`,
      [handleHash, revokedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getTokenCiphertext(id: string, now: Date) {
    const result = await this.pool.query<{ token_ciphertext: string }>(
      `SELECT token_ciphertext
         FROM account_sessions
        WHERE id = $1
          AND revoked_at IS NULL
          AND idle_expires_at > $2
          AND absolute_expires_at > $2`,
      [id, now],
    );
    return result.rows[0]?.token_ciphertext ?? null;
  }

  async replaceTokenCiphertext(
    id: string,
    expectedCiphertext: string,
    replacementCiphertext: string,
    now: Date,
  ) {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET token_ciphertext = $3
        WHERE id = $1
          AND token_ciphertext = $2
          AND revoked_at IS NULL
          AND idle_expires_at > $4
          AND absolute_expires_at > $4`,
      [id, expectedCiphertext, replacementCiphertext, now],
    );
    return result.rowCount === 1;
  }

  async revokeById(id: string, revokedAt: Date) {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, revokedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteByIdReturningToken(id: string) {
    const result = await this.pool.query<{ token_ciphertext: string }>(
      "DELETE FROM account_sessions WHERE id = $1 RETURNING token_ciphertext",
      [id],
    );
    return result.rows[0]?.token_ciphertext ?? null;
  }
}

export class PostgresBackchannelLogoutRepository implements BackchannelLogoutRepository {
  constructor(private readonly pool: Pool) {}

  consumeAndDeleteSessions(input: BackchannelLogoutInput) {
    return transaction(this.pool, async (client) => {
      const replay = await client.query(
        `INSERT INTO account_backchannel_logout_replays (jti_hash, seen_at, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (jti_hash) DO NOTHING`,
        [input.jtiHash, input.seenAt, input.replayExpiresAt],
      );
      if (replay.rowCount !== 1) return { accepted: false, deletedSessions: 0 };

      const deleted = await client.query(
        `DELETE FROM account_sessions
          WHERE ($1::text IS NOT NULL AND keycloak_sid = $1)
             OR ($1::text IS NULL AND $2::text IS NOT NULL AND subject = $2)`,
        [input.keycloakSid ?? null, input.subject ?? null],
      );
      return { accepted: true, deletedSessions: deleted.rowCount ?? 0 };
    });
  }
}

export class PostgresRateLimitRepository implements RateLimitRepository {
  constructor(private readonly pool: Pool) {}

  async consume(input: RateLimitInput) {
    const result = await this.pool.query<{ request_count: number }>(
      `INSERT INTO account_auth_rate_limits
        (key_hash, window_started_at, request_count, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key_hash) DO UPDATE SET
         window_started_at = CASE
           WHEN account_auth_rate_limits.window_started_at < EXCLUDED.window_started_at
             THEN EXCLUDED.window_started_at
           ELSE account_auth_rate_limits.window_started_at
         END,
         request_count = CASE
           WHEN account_auth_rate_limits.window_started_at < EXCLUDED.window_started_at THEN 1
           ELSE account_auth_rate_limits.request_count + 1
         END,
         expires_at = GREATEST(account_auth_rate_limits.expires_at, EXCLUDED.expires_at)
       RETURNING request_count`,
      [input.keyHash, input.windowStartedAt, input.windowExpiresAt],
    );
    const count = result.rows[0]?.request_count ?? input.limit + 1;
    return { allowed: count <= input.limit, count };
  }
}

type NativeIdentityRow = {
  subject: string;
  keycloak_sid: string;
  authenticated_at: Date;
};

function nativeIdentity(row: NativeIdentityRow) {
  return {
    subject: row.subject,
    keycloakSid: row.keycloak_sid,
    authenticatedAt: row.authenticated_at,
  };
}

export class PostgresNativeHandoffRepository implements NativeHandoffRepository {
  constructor(private readonly pool: Pool) {}

  async insert(value: NewNativeHandoff) {
    await this.pool.query(
      `INSERT INTO account_native_handoffs
        (id, code_hash, subject, keycloak_sid, authenticated_at, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        value.id,
        value.codeHash,
        value.subject,
        value.keycloakSid,
        value.authenticatedAt,
        value.createdAt,
        value.expiresAt,
      ],
    );
  }

  async consumeAndCreateBridge(input: ConsumeNativeHandoffInput) {
    const result = await this.pool.query<NativeIdentityRow>(
      `WITH consumed AS (
         UPDATE account_native_handoffs
            SET consumed_at = $4
          WHERE code_hash = $1
            AND consumed_at IS NULL
            AND expires_at > $4
        RETURNING subject, keycloak_sid, authenticated_at, expires_at
       )
       INSERT INTO account_native_bridges
         (id, code_hash, subject, keycloak_sid, authenticated_at, created_at, expires_at)
       SELECT $2, $3, subject, keycloak_sid, authenticated_at, $4, LEAST(expires_at, $5)
         FROM consumed
      RETURNING subject, keycloak_sid, authenticated_at`,
      [
        input.publicCodeHash,
        input.bridgeId,
        input.bridgeCodeHash,
        input.now,
        input.bridgeExpiresAt,
      ],
    );
    const row = result.rows[0];
    return row ? nativeIdentity(row) : null;
  }

  redeemBridge(input: RedeemNativeBridgeInput) {
    return transaction(this.pool, async (client) => {
      const nonce = await client.query(
        `INSERT INTO account_native_bridge_request_nonces (nonce_hash, seen_at, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (nonce_hash) DO NOTHING`,
        [input.requestNonceHash, input.now, input.requestNonceExpiresAt],
      );
      if (nonce.rowCount !== 1) return null;
      const result = await client.query<NativeIdentityRow>(
        `UPDATE account_native_bridges
            SET consumed_at = $2
          WHERE code_hash = $1
            AND consumed_at IS NULL
            AND expires_at > $2
        RETURNING subject, keycloak_sid, authenticated_at`,
        [input.bridgeCodeHash, input.now],
      );
      const row = result.rows[0];
      return row ? nativeIdentity(row) : null;
    });
  }
}
