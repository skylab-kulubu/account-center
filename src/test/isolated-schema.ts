import { Pool } from "pg";

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A PostgreSQL schema of the test file's own, so database tests never share
 * tables: vitest runs test files in parallel, and two files migrating,
 * truncating or seeding the same `public` tables can wipe each other's rows
 * mid-test. `pool` has the schema as its `search_path` (the migrations name
 * no schema and fingerprint `current_schema()`); `create()` starts it empty,
 * `drop()` closes the pool and removes the schema.
 */
export function isolatedSchema(databaseUrl: string | undefined, schema: string, max = 2) {
  if (!SCHEMA_NAME.test(schema) || schema === "public") throw new Error(`Invalid test schema name: ${schema}`);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({ connectionString: databaseUrl, max, options: `-c search_path=${schema}` });
  return {
    pool,
    async create() {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
    },
    async drop() {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    },
  };
}
