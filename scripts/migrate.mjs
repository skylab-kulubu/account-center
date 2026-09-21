import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { serializeDatabaseError } from "./database-error.mjs";
import { validateDatabaseEnvironment } from "./validate-env.mjs";

validateDatabaseEnvironment(process.env);

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

try {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();

  for (const name of files) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [781_904_214]);
      await client.query(
        "CREATE TABLE IF NOT EXISTS account_center_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const existing = await client.query(
        "SELECT 1 FROM account_center_schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount === 0) {
        await client.query(await readFile(join(migrationsDirectory, name), "utf8"));
        await client.query("INSERT INTO account_center_schema_migrations (name) VALUES ($1)", [name]);
        console.info(JSON.stringify({ event: "database_migration_applied", migration: name }));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} catch (error) {
  console.error(JSON.stringify(serializeDatabaseError(error)));
  process.exitCode = 1;
} finally {
  await pool.end();
}
