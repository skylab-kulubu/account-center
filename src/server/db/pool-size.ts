/** Mirrors validateDatabasePoolEnvironment in scripts/validate-env.mjs. */
export const DEFAULT_DATABASE_POOL_MAX = 10;

/**
 * Connections one task may hold. Every task (and the second one a start-first deploy runs
 * for a moment) takes this many from the database role's limit, so size it with the replicas.
 */
export function databasePoolMax(value: string | undefined) {
  const text = value?.trim();
  if (!text) return DEFAULT_DATABASE_POOL_MAX;
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("DATABASE_POOL_MAX must be an integer between 1 and 100.");
  }
  return parsed;
}
