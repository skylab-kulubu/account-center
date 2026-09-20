// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getAccountAccessGateConfig } from "@/server/access-gate/config";

const originalEnvironment = { ...process.env };
const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");
const pemDirectory = mkdtempSync(join(tmpdir(), "account-access-mtls-"));
const caPath = join(pemDirectory, "ca.crt");
const certPath = join(pemDirectory, "client.crt");
const keyPath = join(pemDirectory, "client.key");
writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n");
writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\ntest-client\n-----END CERTIFICATE-----\n");
writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----\n");

function enforceEnvironment() {
  Object.assign(process.env, {
    ACCOUNT_ACCESS_GATE_MODE: "enforce",
    ACCOUNT_ACCESS_REDIS_HOST: "127.0.0.1",
    ACCOUNT_ACCESS_REDIS_PORT: "6389",
    ACCOUNT_ACCESS_REDIS_USERNAME: "account-center-reader",
    ACCOUNT_ACCESS_REDIS_PASSWORD: "test-secret",
    ACCOUNT_ACCESS_REDIS_DATABASE: "7",
    ACCOUNT_ACCESS_REDIS_TLS: "false",
    ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS: "200",
  });
  delete process.env.ACCOUNT_ACCESS_REDIS_TLS_SERVER_NAME;
  delete process.env.ACCOUNT_ACCESS_REDIS_CA_CERT_FILE;
  delete process.env.ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE;
  delete process.env.ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE;
}

afterEach(() => {
  process.env = { ...originalEnvironment };
});

afterAll(() => {
  rmSync(pemDirectory, { recursive: true, force: true });
});

describe("account access gate configuration", () => {
  it("requires an explicit mode", () => {
    delete process.env.ACCOUNT_ACCESS_GATE_MODE;
    expect(() => getAccountAccessGateConfig(issuer)).toThrow(/ACCOUNT_ACCESS_GATE_MODE/);
  });

  it("accepts explicit off without Redis configuration", () => {
    process.env.ACCOUNT_ACCESS_GATE_MODE = "off";
    expect(getAccountAccessGateConfig(issuer)).toEqual({ mode: "off" });
  });

  it("requires complete bounded dedicated Redis configuration in enforce mode", () => {
    enforceEnvironment();
    expect(getAccountAccessGateConfig(issuer)).toEqual({
      mode: "enforce",
      host: "127.0.0.1",
      port: 6389,
      username: "account-center-reader",
      password: "test-secret",
      database: 7,
      tls: false,
      operationTimeoutMs: 200,
    });

    delete process.env.ACCOUNT_ACCESS_REDIS_PASSWORD;
    expect(() => getAccountAccessGateConfig(issuer)).toThrow(/ACCOUNT_ACCESS_REDIS_PASSWORD/);
  });

  it("pins enforce mode to the exact v1 issuer", () => {
    enforceEnvironment();
    expect(() => getAccountAccessGateConfig(
      new URL("https://identity.example/realms/other"),
    )).toThrow(/account access v1 contract/);
  });

  it("requires authenticated TLS when running in production", () => {
    enforceEnvironment();
    Object.assign(process.env, { NODE_ENV: "production" });
    expect(() => getAccountAccessGateConfig(issuer)).toThrow(/must be true in production/);

    process.env.ACCOUNT_ACCESS_REDIS_TLS = "true";
    process.env.ACCOUNT_ACCESS_REDIS_TLS_SERVER_NAME = "redis.internal";
    process.env.ACCOUNT_ACCESS_REDIS_CA_CERT_FILE = caPath;
    process.env.ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE = certPath;
    process.env.ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE = keyPath;
    expect(getAccountAccessGateConfig(issuer)).toMatchObject({
      tls: true,
      tlsServerName: "redis.internal",
      tlsCa: expect.stringContaining("BEGIN CERTIFICATE"),
      tlsCert: expect.stringContaining("BEGIN CERTIFICATE"),
      tlsKey: expect.stringContaining("BEGIN PRIVATE KEY"),
    });
  });

  it("requires readable client mTLS material when TLS is enabled", () => {
    enforceEnvironment();
    process.env.ACCOUNT_ACCESS_REDIS_TLS = "true";
    process.env.ACCOUNT_ACCESS_REDIS_TLS_SERVER_NAME = "redis.internal";
    process.env.ACCOUNT_ACCESS_REDIS_CA_CERT_FILE = caPath;
    process.env.ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE = certPath;
    process.env.ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE = "/missing/client.key";
    expect(() => getAccountAccessGateConfig(issuer)).toThrow(/TLS_KEY_FILE.*readable/);
  });
});
