import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateDatabaseEnvironment, validateEnvironment } from "./validate-env.mjs";

const valid = {
  APP_URL: "https://my.yildizskylab.com",
  DATABASE_URL: "postgres://account_center:correct-horse-battery@postgres:5432/account_center?sslmode=require",
  SESSION_SECRET: "XcD38kffowY7jPHZGFGh8RrX0NdYGTM_7aMz32TEiBI",
  TOKEN_ENCRYPTION_KEY: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI",
  OIDC_ISSUER: "https://e.yildizskylab.com/realms/e-skylab",
  OIDC_CLIENT_ID: "account-center",
  OIDC_CLIENT_SECRET: "5wr2CLN30UE1phQPkCVpL2G7x6hM8nRc",
  OIDC_UPSTREAM_SESSION_MAX_SECONDS: "28800",
  AUTH_TRUSTED_PROXY: "cloudflare",
  NATIVE_BRIDGE_HMAC_SECRET: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  NATIVE_BRIDGE_MTLS_CLIENT_SHA256: "ab".repeat(32),
  ACCOUNT_ACCESS_GATE_MODE: "enforce",
  ACCOUNT_ACCESS_REDIS_HOST: "account-access-redis.internal",
  ACCOUNT_ACCESS_REDIS_PORT: "6379",
  ACCOUNT_ACCESS_REDIS_USERNAME: "account-center-reader",
  ACCOUNT_ACCESS_REDIS_PASSWORD: "dedicated-access-gate-secret",
  ACCOUNT_ACCESS_REDIS_DATABASE: "0",
  ACCOUNT_ACCESS_REDIS_TLS: "true",
  ACCOUNT_ACCESS_REDIS_TLS_SERVER_NAME: "account-access-redis.internal",
  ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS: "200",
};
const issuerContract = JSON.parse(
  readFileSync(new URL("../tests/fixtures/oidc-issuer-contract.json", import.meta.url), "utf8"),
);
const appUrlContract = JSON.parse(
  readFileSync(new URL("../tests/fixtures/app-url-contract.json", import.meta.url), "utf8"),
);

test("accepts a complete production environment", () => {
  assert.doesNotThrow(() => validateEnvironment(valid));
});

test("allows maintenance commands to receive only the database secret", () => {
  assert.doesNotThrow(() => validateDatabaseEnvironment({ DATABASE_URL: valid.DATABASE_URL }));
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

test("requires an exact 32-byte token encryption key", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, TOKEN_ENCRYPTION_KEY: "c2hvcnQ" }),
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

test("uses the same canonical Keycloak realm issuer contract as runtime", () => {
  for (const issuer of issuerContract.valid) {
    assert.doesNotThrow(() => validateEnvironment({ ...valid, OIDC_ISSUER: issuer }));
  }
  for (const issuer of issuerContract.invalid) {
    assert.throws(
      () => validateEnvironment({ ...valid, OIDC_ISSUER: issuer }),
      /OIDC_ISSUER/,
    );
  }
});

test("uses the same canonical credential-free application origin contract as runtime", () => {
  for (const appUrl of appUrlContract.valid) {
    assert.doesNotThrow(() => validateEnvironment({ ...valid, APP_URL: appUrl }));
  }
  for (const appUrl of appUrlContract.invalid) {
    assert.throws(() => validateEnvironment({ ...valid, APP_URL: appUrl }), /APP_URL/);
  }
});

test("requires a verified, safely bounded upstream session maximum", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, OIDC_UPSTREAM_SESSION_MAX_SECONDS: "<verify-in-keycloak>" }),
    /integer/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, OIDC_UPSTREAM_SESSION_MAX_SECONDS: "31536000" }),
    /safe range/,
  );
});

test("accepts only the documented trusted proxy boundary", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, AUTH_TRUSTED_PROXY: "x-forwarded-for" }),
    /cloudflare/,
  );
});

test("requires pinned native bridge transport credentials", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, NATIVE_BRIDGE_HMAC_SECRET: "c2hvcnQ=" }),
    /32 bytes/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, NATIVE_BRIDGE_MTLS_CLIENT_SHA256: "AB".repeat(32) }),
    /NATIVE_BRIDGE_MTLS_CLIENT_SHA256/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, NATIVE_BRIDGE_HMAC_SECRET: valid.SESSION_SECRET }),
    /must differ/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, NATIVE_BRIDGE_HMAC_SECRET: valid.TOKEN_ENCRYPTION_KEY }),
    /must differ/,
  );
});

test("requires the complete dedicated Redis contract in enforce mode", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, ACCOUNT_ACCESS_REDIS_PASSWORD: "" }),
    /ACCOUNT_ACCESS_REDIS_PASSWORD/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, ACCOUNT_ACCESS_REDIS_TLS: "false" }),
    /must be true in production/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, OIDC_ISSUER: "https://identity.example/realms/other" }),
    /account access v1 contract/,
  );
});

test("permits an explicit off mode without Redis credentials", () => {
  const environment = Object.fromEntries(
    Object.entries({ ...valid, ACCOUNT_ACCESS_GATE_MODE: "off" })
      .filter(([name]) => !name.startsWith("ACCOUNT_ACCESS_REDIS_")),
  );
  assert.doesNotThrow(() => validateEnvironment(environment));
});
