import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEnvironment } from "./validate-env.mjs";

const valid = {
  APP_URL: "https://my.yildizskylab.com",
  DATABASE_URL: "postgres://account_center:correct-horse-battery@postgres:5432/account_center?sslmode=require",
  SESSION_SECRET: "XcD38kffowY7jPHZGFGh8RrX0NdYGTM_7aMz32TEiBI",
  OIDC_ISSUER: "https://e.yildizskylab.com/realms/e-skylab",
  OIDC_CLIENT_ID: "account-center",
  OIDC_CLIENT_SECRET: "5wr2CLN30UE1phQPkCVpL2G7x6hM8nRc",
};

test("accepts a complete production environment", () => {
  assert.doesNotThrow(() => validateEnvironment(valid));
});

test("rejects documentation placeholders", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, OIDC_CLIENT_SECRET: "replace-with-keycloak-client-secret" }),
    /placeholder/,
  );
});

test("rejects short session secrets", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, SESSION_SECRET: "short-secret" }),
    /32 bytes/,
  );
});

test("rejects secrets exposed through NEXT_PUBLIC_", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, NEXT_PUBLIC_SESSION_SECRET: valid.SESSION_SECRET }),
    /NEXT_PUBLIC_/,
  );
});

test("requires HTTPS for public and issuer URLs", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, APP_URL: "http://my.yildizskylab.com" }),
    /HTTPS/,
  );
});
