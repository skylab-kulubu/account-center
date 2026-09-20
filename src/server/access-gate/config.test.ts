// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { getAccountAccessGateConfig } from "@/server/access-gate/config";

const originalEnvironment = { ...process.env };
const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");

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
  delete process.env.ACCOUNT_ACCESS_REDIS_TLS_CA_BASE64;
}

afterEach(() => {
  process.env = { ...originalEnvironment };
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
    expect(getAccountAccessGateConfig(issuer)).toMatchObject({
      tls: true,
      tlsServerName: "redis.internal",
    });
  });
});
