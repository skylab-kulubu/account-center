import "server-only";

import type { Pool, PoolClient } from "pg";
import type {
  BackchannelLogoutInput,
  BackchannelLogoutRepository,
  OidcTransactionRepository,
  RateLimitInput,
  RateLimitRepository,
  SessionRepository,
  SessionUseOutcome,
  StoredSudo,
  SudoRepository,
  UseSessionInput,
} from "@/server/auth/repositories";
import type {
  ActiveSession,
  NewSessionRecord,
  StoredOidcTransaction,
} from "@/server/auth/types";

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
  /** Salt of the last rotation (0010); null before the first rotation of this image. */
  rotation_salt?: Buffer | null;
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

  async findByHandle(handleHash: Buffer, now: Date) {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, subject, keycloak_sid, handle_hash, previous_handle_hash,
              previous_handle_expires_at, created_at, rotated_at, last_seen_at,
              idle_expires_at, absolute_expires_at, revoked_at
         FROM account_sessions
        WHERE (handle_hash = $1
               OR (previous_handle_hash = $1 AND previous_handle_expires_at > $2))
          AND revoked_at IS NULL
          AND idle_expires_at > $2
          AND absolute_expires_at > $2
        LIMIT 1`,
      [handleHash, now],
    );
    const row = result.rows[0];
    return row ? activeSession(row) : null;
  }

  async useHandle(input: UseSessionInput): Promise<SessionUseOutcome | null> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<SessionRow>(
        `SELECT id, subject, keycloak_sid, handle_hash, previous_handle_hash,
                previous_handle_expires_at, created_at, rotated_at, last_seen_at,
                idle_expires_at, absolute_expires_at, revoked_at, rotation_salt
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

      const idleExpiresAt = new Date(
        Math.min(
          row.absolute_expires_at.getTime(),
          input.now.getTime() + input.idleTtlSeconds * 1_000,
        ),
      );
      const touch = () => client.query(
        `UPDATE account_sessions
            SET last_seen_at = $2,
                idle_expires_at = $3
          WHERE id = $1`,
        [row.id, input.now, idleExpiresAt],
      );

      // A valid previous handle is the handle the current one was derived from: a request that still
      // carries it (its Set-Cookie response was lost, or it was sent beside the rotating request, from
      // another tab too) gets the same successor back, so every answer in the window sets one cookie.
      // Nothing changes in the row; the previous handle keeps its own expiry. A row whose current
      // handle is not that successor (rotated by an older image, without a salt) falls back to a fresh
      // rotation that keeps the current handle as the previous one, as before.
      if (matchedPrevious && input.allowRotation && row.rotation_salt
        && input.successorHash(row.rotation_salt).equals(row.handle_hash)) {
        await touch();
        return {
          session: activeSession(row, input.now, idleExpiresAt),
          rotated: true,
          rotationSalt: row.rotation_salt,
        };
      }

      const rotationDue =
        input.allowRotation &&
        (matchedPrevious ||
          (matchedCurrent &&
            row.rotated_at.getTime() <= input.now.getTime() - input.rotateAfterSeconds * 1_000));

      if (rotationDue) {
        await client.query(
          `UPDATE account_sessions
              SET previous_handle_hash = handle_hash,
                  previous_handle_expires_at = $3,
                  handle_hash = $2,
                  rotation_salt = $6,
                  rotated_at = $4,
                  last_seen_at = $4,
                  idle_expires_at = $5
            WHERE id = $1`,
          [
            row.id,
            input.successorHash(input.newRotationSalt),
            new Date(input.now.getTime() + input.previousHandleGraceSeconds * 1_000),
            input.now,
            idleExpiresAt,
            input.newRotationSalt,
          ],
        );
        return {
          session: activeSession(row, input.now, idleExpiresAt),
          rotated: true,
          rotationSalt: input.newRotationSalt,
        };
      }
      await touch();
      return { session: activeSession(row, input.now, idleExpiresAt), rotated: false };
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

  async revokeBySubject(subject: string, revokedAt: Date) {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
        WHERE subject = $1
          AND revoked_at IS NULL`,
      [subject, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  async revokeSubjectBySessionId(sessionId: string, revokedAt: Date) {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
        WHERE subject = (SELECT subject FROM account_sessions WHERE id = $1)
      RETURNING id`,
      [sessionId, revokedAt],
    );
    return result.rowCount ?? 0;
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
    keycloakSid: string | undefined,
    now: Date,
  ) {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET token_ciphertext = $3,
              keycloak_sid = COALESCE($4, keycloak_sid)
        WHERE id = $1
          AND token_ciphertext = $2
          AND revoked_at IS NULL
          AND idle_expires_at > $5
          AND absolute_expires_at > $5`,
      [id, expectedCiphertext, replacementCiphertext, keycloakSid ?? null, now],
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

export class PostgresSudoRepository implements SudoRepository {
  constructor(private readonly pool: Pool) {}

  async replaceSudo(sessionId: string, ciphertext: string, expiresAt: Date, now: Date) {
    const result = await this.pool.query(
      `UPDATE account_sessions
          SET sudo_token_ciphertext = $2,
              sudo_expires_at = $3
        WHERE id = $1
          AND revoked_at IS NULL
          AND idle_expires_at > $4
          AND absolute_expires_at > $4`,
      [sessionId, ciphertext, expiresAt, now],
    );
    return result.rowCount === 1;
  }

  async readSudo(sessionId: string, now: Date): Promise<StoredSudo | null> {
    const result = await this.pool.query<{ sudo_token_ciphertext: string; sudo_expires_at: Date }>(
      `SELECT sudo_token_ciphertext, sudo_expires_at
         FROM account_sessions
        WHERE id = $1
          AND sudo_token_ciphertext IS NOT NULL
          AND sudo_expires_at IS NOT NULL
          AND revoked_at IS NULL
          AND idle_expires_at > $2
          AND absolute_expires_at > $2`,
      [sessionId, now],
    );
    const row = result.rows[0];
    return row ? { ciphertext: row.sudo_token_ciphertext, expiresAt: row.sudo_expires_at } : null;
  }

  async clearSudo(sessionId: string) {
    await this.pool.query(
      `UPDATE account_sessions
          SET sudo_token_ciphertext = NULL,
              sudo_expires_at = NULL
        WHERE id = $1
          AND (sudo_token_ciphertext IS NOT NULL OR sudo_expires_at IS NOT NULL)`,
      [sessionId],
    );
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
