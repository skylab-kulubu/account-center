/**
 * How long, at most, a deleted person's data can outlive the deletion in
 * backups, as promised on the confirmation step. It is the longest of the
 * operational limits: the encrypted nightly R2 backup is gone within 31 days,
 * and hand-taken dumps are capped at `PERIODIC_DESTRUCTION_INTERVAL` (90 days,
 * account-erasure ticket 19). Change it only together with those limits.
 */
export const ACCOUNT_DELETION_BACKUP_RETENTION_DAYS = 90;
