import "server-only";

import type { Pool } from "pg";
import { hmacSha256 } from "@/server/auth/crypto";
import { isPrimaryEmailNudge } from "@/lib/primary-email-nudge";
import type { PrimaryEmailNudge } from "@/lib/primary-email-nudge";

/** Rows of `account_notice_dismissals` (migration 0009), addressed by the subject digest only. */
export interface NoticeDismissalRepository {
  list(subjectDigest: Buffer): Promise<string[]>;
  dismiss(subjectDigest: Buffer, notice: PrimaryEmailNudge, now: Date): Promise<void>;
  forget(subjectDigest: Buffer): Promise<void>;
}

export class PostgresNoticeDismissalRepository implements NoticeDismissalRepository {
  constructor(private readonly pool: Pool) {}

  async list(subjectDigest: Buffer) {
    const result = await this.pool.query<{ notice: string }>(
      "SELECT notice FROM account_notice_dismissals WHERE subject_digest = $1",
      [subjectDigest],
    );
    return result.rows.map((row) => row.notice);
  }

  /** Idempotent: dismissing again keeps the first moment. */
  async dismiss(subjectDigest: Buffer, notice: PrimaryEmailNudge, now: Date) {
    await this.pool.query(
      `INSERT INTO account_notice_dismissals (subject_digest, notice, dismissed_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (subject_digest, notice) DO NOTHING`,
      [subjectDigest, notice, now],
    );
  }

  async forget(subjectDigest: Buffer) {
    await this.pool.query("DELETE FROM account_notice_dismissals WHERE subject_digest = $1", [subjectDigest]);
  }
}

/**
 * The nudges a person dismissed for good (K4c), kept server-side so the
 * choice follows them to every device. The person is addressed by an HMAC of
 * their Keycloak subject under its own purpose, so this table can be joined
 * neither to the subject nor to the deletion intents without the secret.
 */
export class NoticeDismissals {
  constructor(
    private readonly repository: NoticeDismissalRepository,
    private readonly hmacSecret: Buffer,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  #digest(subject: string) {
    return hmacSha256(this.hmacSecret, "notice-dismissal-subject", subject);
  }

  async list(subject: string): Promise<Set<PrimaryEmailNudge>> {
    const notices = await this.repository.list(this.#digest(subject));
    return new Set(notices.filter(isPrimaryEmailNudge));
  }

  dismiss(subject: string, notice: PrimaryEmailNudge) {
    return this.repository.dismiss(this.#digest(subject), notice, this.clock());
  }

  /**
   * Called when the person confirms an account deletion, before core is
   * called; best effort (a failure never stops the deletion) and only where
   * the deletion flow runs (`ACCOUNT_ERASURE_MODE=enforce`). Rows the person
   * never deletes go twelve months after the dismissal (prune-auth).
   */
  forget(subject: string) {
    return this.repository.forget(this.#digest(subject));
  }
}
