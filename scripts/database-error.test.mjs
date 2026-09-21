import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeDatabaseError } from "./database-error.mjs";

test("reports safe PostgreSQL migration diagnostics", () => {
  const error = Object.assign(new Error("unexpected constraint fingerprint"), {
    code: "P0001",
    schema: "public",
    table: "account_deletion_intents",
    constraint: "account_deletion_intents_status_check",
    detail: "must not be logged",
    query: "must not be logged",
  });

  assert.deepEqual(serializeDatabaseError(error), {
    event: "database_migration_failed",
    error: "unexpected constraint fingerprint",
    code: "P0001",
    schema: "public",
    table: "account_deletion_intents",
    constraint: "account_deletion_intents_status_check",
  });
});

test("does not leak unknown thrown values", () => {
  assert.deepEqual(serializeDatabaseError("database-password"), {
    event: "database_migration_failed",
  });
});
