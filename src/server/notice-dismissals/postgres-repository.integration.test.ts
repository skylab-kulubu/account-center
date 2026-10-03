// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresNoticeDismissalRepository } from "@/server/notice-dismissals/store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const migrationPath = resolve(process.cwd(), "migrations", "0009_account_notice_dismissals.sql");

databaseDescribe("PostgreSQL notice dismissals", () => {
  // Its own schema: nothing else in the suite touches it, so it can run beside the other database tests.
  const schema = "account_notice_dismissals_test";
  const pool = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });
  const repository = new PostgresNoticeDismissalRepository(pool);
  const ada = Buffer.alloc(32, 1);
  const grace = Buffer.alloc(32, 2);
  let migration = "";

  beforeAll(async () => {
    migration = await readFile(migrationPath, "utf8");
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(migration);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE account_notice_dismissals");
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("applies the migration again without change", async () => {
    await expect(pool.query(migration)).resolves.toBeDefined();
  });

  it("keeps one row per person and nudge, the first moment winning", async () => {
    await repository.dismiss(ada, "add-personal", new Date("2026-10-03T12:00:00Z"));
    await repository.dismiss(ada, "add-personal", new Date("2026-10-04T12:00:00Z"));
    await repository.dismiss(ada, "make-personal-primary", new Date("2026-10-05T12:00:00Z"));
    await repository.dismiss(grace, "add-personal", new Date("2026-10-03T12:00:00Z"));

    expect((await repository.list(ada)).sort()).toEqual(["add-personal", "make-personal-primary"]);
    expect(await repository.list(grace)).toEqual(["add-personal"]);
    const stored = await pool.query<{ dismissed_at: Date }>(
      "SELECT dismissed_at FROM account_notice_dismissals WHERE subject_digest = $1 AND notice = 'add-personal'",
      [ada],
    );
    expect(stored.rows[0]?.dismissed_at.toISOString()).toBe("2026-10-03T12:00:00.000Z");
  });

  it("forgets one person without touching another", async () => {
    await repository.dismiss(ada, "add-personal", new Date());
    await repository.dismiss(grace, "add-personal", new Date());

    await repository.forget(ada);

    expect(await repository.list(ada)).toEqual([]);
    expect(await repository.list(grace)).toEqual(["add-personal"]);
  });

  it("refuses an unknown nudge and a digest of the wrong length", async () => {
    await expect(pool.query(
      "INSERT INTO account_notice_dismissals VALUES ($1, 'remove-personal', now())",
      [ada],
    )).rejects.toThrow(/check constraint/);
    await expect(pool.query(
      "INSERT INTO account_notice_dismissals VALUES ($1, 'add-personal', now())",
      [Buffer.alloc(16)],
    )).rejects.toThrow(/check constraint/);
  });

  it("stops on a table that does not match the expected shape", async () => {
    await pool.query("ALTER TABLE account_notice_dismissals ADD COLUMN extra text");
    try {
      await expect(pool.query(migration)).rejects.toThrow(/unexpected column fingerprint/);
    } finally {
      await pool.query("ALTER TABLE account_notice_dismissals DROP COLUMN extra");
    }
  });
});
