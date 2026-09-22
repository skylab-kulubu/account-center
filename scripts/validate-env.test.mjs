import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validateDatabaseEnvironment, validateEnvironment } from "./validate-env.mjs";

const pemDirectory = mkdtempSync(join(tmpdir(), "account-access-env-mtls-"));
const caPath = join(pemDirectory, "ca.crt");
const certPath = join(pemDirectory, "client.crt");
const keyPath = join(pemDirectory, "client.key");
writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n");
writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\ntest-client\n-----END CERTIFICATE-----\n");
writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----\n");

after(() => rmSync(pemDirectory, { recursive: true, force: true }));

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
  ACCOUNT_ACCESS_REDIS_CA_CERT_FILE: caPath,
  ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE: certPath,
  ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE: keyPath,
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

test("requires the dedicated Account Center OIDC client", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, OIDC_CLIENT_ID: "account-console" }),
    /dedicated account-center client/,
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

test("accepts only the three documented trusted proxy boundaries", () => {
  for (const mode of ["cloudflare", "traefik", "none"]) {
    assert.doesNotThrow(() => validateEnvironment({ ...valid, AUTH_TRUSTED_PROXY: mode }));
  }
  for (const invalid of ["x-forwarded-for", "Traefik", "traefik,none", "<proxy>"]) {
    assert.throws(
      () => validateEnvironment({ ...valid, AUTH_TRUSTED_PROXY: invalid }),
      /AUTH_TRUSTED_PROXY must be cloudflare, traefik or none/,
    );
  }
});

test("accepts only canonical CIDR blocks as trusted proxy ranges", () => {
  const traefik = { ...valid, AUTH_TRUSTED_PROXY: "traefik" };
  assert.doesNotThrow(() => validateEnvironment(traefik));
  for (const ranges of [
    "10.0.0.0/8",
    " 10.0.1.0/24 , 172.16.0.0/12 ",
    "::1/128,fc00::/7",
    "0.0.0.0/0",
    "::ffff:0:0/96",
  ]) {
    assert.doesNotThrow(
      () => validateEnvironment({ ...traefik, AUTH_TRUSTED_PROXY_RANGES: ranges }),
      ranges,
    );
  }
  for (const ranges of [
    "10.0.0.1/8",
    "10.0.0.0",
    "10.0.0.0/33",
    "10.0.0.0/8/8",
    "::1/129",
    "2001:db8::1/32",
    "fe80::1%eth0/64",
    "10.0.0.0/08",
    "not-an-address/8",
    ",",
  ]) {
    assert.throws(
      () => validateEnvironment({ ...traefik, AUTH_TRUSTED_PROXY_RANGES: ranges }),
      /AUTH_TRUSTED_PROXY_RANGES/,
      ranges,
    );
  }
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
  assert.throws(
    () => validateEnvironment({ ...valid, ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE: "/missing/client.key" }),
    /TLS_KEY_FILE.*readable/,
  );
});

test("permits an explicit off mode without Redis credentials", () => {
  const environment = Object.fromEntries(
    Object.entries({ ...valid, ACCOUNT_ACCESS_GATE_MODE: "off" })
      .filter(([name]) => !name.startsWith("ACCOUNT_ACCESS_REDIS_")),
  );
  assert.doesNotThrow(() => validateEnvironment(environment));
});

test("validates the optional profile picture origin whenever it is present", () => {
  assert.doesNotThrow(() => validateEnvironment({ ...valid, PROFILE_PICTURE_ORIGIN: "https://media.yildizskylab.com" }));
  assert.doesNotThrow(() => validateEnvironment({ ...valid, PROFILE_PICTURE_ORIGIN: "" }));
  for (const invalid of [
    "http://media.yildizskylab.com",
    "https://media.yildizskylab.com/media/",
    "https://user:secret@media.yildizskylab.com",
    "https://<cdn-origin>",
  ]) {
    assert.throws(() => validateEnvironment({ ...valid, PROFILE_PICTURE_ORIGIN: invalid }), /PROFILE_PICTURE_ORIGIN/);
  }
});

test("validates the optional club-profile Core origin whenever it is present", () => {
  assert.doesNotThrow(() => validateEnvironment({ ...valid, CORE_API_URL: "https://api.yildizskylab.com" }));
  assert.throws(
    () => validateEnvironment({ ...valid, CORE_API_URL: "http://api.yildizskylab.com" }),
    /CORE_API_URL/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, CORE_API_URL: "https://api.yildizskylab.com/v1/" }),
    /CORE_API_URL/,
  );
  assert.throws(
    () => validateEnvironment({ ...valid, CORE_API_URL: "https://<core-origin>" }),
    /placeholder/,
  );
});

test("validates the optional YTÜ identity provider alias whenever it is present", () => {
  assert.doesNotThrow(() => validateEnvironment({ ...valid, YTU_IDP_ALIAS: "OBS" }));
  assert.doesNotThrow(() => validateEnvironment({ ...valid, YTU_IDP_ALIAS: "obs-sandbox_2" }));
  assert.doesNotThrow(() => validateEnvironment({ ...valid, YTU_IDP_ALIAS: "" }));
  for (const invalid of ["OBS/link", "OBS OBS", "a".repeat(65), "OBS?x=1", "ÖBS"]) {
    assert.throws(() => validateEnvironment({ ...valid, YTU_IDP_ALIAS: invalid }), /YTU_IDP_ALIAS/);
  }
  assert.throws(() => validateEnvironment({ ...valid, YTU_IDP_ALIAS: "<idp-alias>" }), /placeholder/);
});

test("keeps account erasure default-off and requires the exact Core origin when enabled", () => {
  assert.doesNotThrow(() => validateEnvironment(valid));
  assert.doesNotThrow(() => validateEnvironment({ ...valid, ACCOUNT_ERASURE_MODE: "off" }));
  assert.throws(
    () => validateEnvironment({ ...valid, ACCOUNT_ERASURE_MODE: "enforce" }),
    /CORE_API_URL/,
  );
  assert.throws(
    () => validateEnvironment({
      ...valid,
      ACCOUNT_ERASURE_MODE: "enforce",
      CORE_API_URL: "https://api.yildizskylab.com/v1",
    }),
    /CORE_API_URL/,
  );
  assert.doesNotThrow(() => validateEnvironment({
    ...valid,
    ACCOUNT_ERASURE_MODE: "enforce",
    CORE_API_URL: "https://api.yildizskylab.com",
  }));
  assert.throws(
    () => validateEnvironment({
      ...valid,
      ACCOUNT_ACCESS_GATE_MODE: "off",
      ACCOUNT_ERASURE_MODE: "enforce",
      CORE_API_URL: "https://api.yildizskylab.com",
    }),
    /access gate/i,
  );
});
