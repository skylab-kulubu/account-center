import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateDatabaseEnvironment } from "./validate-env.mjs";

validateDatabaseEnvironment(process.env);

const maintenanceFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "maintenance",
  "prune-auth.sql",
);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [781_904_215]);
    if (lock.rows[0]?.acquired !== true) {
      await client.query("ROLLBACK");
      console.info(JSON.stringify({ event: "auth_prune_skipped", reason: "already_running" }));
    } else {
      const result = await client.query(await readFile(maintenanceFile, "utf8"));
      await client.query("COMMIT");
      console.info(JSON.stringify({
        event: "auth_prune_completed",
        deletedTransactions: result.rows[0]?.deleted_transactions ?? 0,
        deletedSessions: result.rows[0]?.deleted_sessions ?? 0,
        deletedLogoutReplays: result.rows[0]?.deleted_logout_replays ?? 0,
        deletedRateLimits: result.rows[0]?.deleted_rate_limits ?? 0,
        deletedNativeHandoffs: result.rows[0]?.deleted_native_handoffs ?? 0,
        deletedNativeBridges: result.rows[0]?.deleted_native_bridges ?? 0,
        deletedNativeBridgeNonces: result.rows[0]?.deleted_native_bridge_nonces ?? 0,
        deletedActionResults: result.rows[0]?.deleted_action_results ?? 0,
        deletedDeletionIntents: result.rows[0]?.deleted_deletion_intents ?? 0,
        scrubbedDeletionRecovery: result.rows[0]?.scrubbed_deletion_recovery ?? 0,
      }));
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} catch {
  console.error(JSON.stringify({ event: "auth_prune_failed" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
