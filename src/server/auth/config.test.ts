import { afterEach, describe, expect, it } from "vitest";
import { getAuthConfig } from "@/server/auth/config";
import appUrlContract from "../../../tests/fixtures/app-url-contract.json";
import issuerContract from "../../../tests/fixtures/oidc-issuer-contract.json";

const originalEnvironment = { ...process.env };

function environment(upstreamSeconds: string) {
  Object.assign(process.env, {
    APP_URL: "https://my.yildizskylab.com",
    DATABASE_URL: "postgres://account_center:secret@postgres:5432/account_center",
    SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    TOKEN_ENCRYPTION_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    OIDC_ISSUER: "https://e.yildizskylab.com/realms/e-skylab",
    OIDC_CLIENT_ID: "account-center",
    OIDC_CLIENT_SECRET: "client-secret-000000000000000000",
    OIDC_UPSTREAM_SESSION_MAX_SECONDS: upstreamSeconds,
    AUTH_TRUSTED_PROXY: "cloudflare",
    NATIVE_BRIDGE_HMAC_SECRET: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    NATIVE_BRIDGE_MTLS_CLIENT_SHA256: "ab".repeat(32),
  });
}

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("authentication configuration", () => {
  it("caps absolute session life at the verified upstream maximum", () => {
    environment("3600");
    expect(getAuthConfig().sessionAbsoluteTtlSeconds).toBe(3600);
    environment("86400");
    expect(getAuthConfig().sessionAbsoluteTtlSeconds).toBe(8 * 60 * 60);
  });

  it("enforces the canonical credential-free application origin contract", () => {
    for (const appUrl of appUrlContract.valid) {
      environment("3600");
      process.env.APP_URL = appUrl;
      expect(() => getAuthConfig()).not.toThrow();
    }
    for (const appUrl of appUrlContract.invalid) {
      environment("3600");
      process.env.APP_URL = appUrl;
      expect(() => getAuthConfig()).toThrow(/APP_URL/);
    }
  });

  it("rejects an unsafe or unverified upstream maximum", () => {
    environment("<verify-in-keycloak>");
    expect(() => getAuthConfig()).toThrow(/integer/);
    environment("31536000");
    expect(() => getAuthConfig()).toThrow(/safe range/);
  });

  it("enforces the canonical credential-free Keycloak realm issuer contract", () => {
    for (const issuer of issuerContract.valid) {
      environment("3600");
      process.env.OIDC_ISSUER = issuer;
      expect(() => getAuthConfig()).not.toThrow();
    }
    for (const issuer of issuerContract.invalid) {
      environment("3600");
      process.env.OIDC_ISSUER = issuer;
      expect(() => getAuthConfig()).toThrow(/OIDC_ISSUER/);
    }
  });

  it("requires separate pinned HMAC and mTLS credentials for bridge redemption", () => {
    environment("3600");
    expect(getAuthConfig()).toMatchObject({
      nativeBridgeHmacSecret: Buffer.alloc(32, 1),
      nativeBridgeMtlsClientSha256: "ab".repeat(32),
    });
    process.env.NATIVE_BRIDGE_MTLS_CLIENT_SHA256 = "not-a-certificate-fingerprint";
    expect(() => getAuthConfig()).toThrow(/NATIVE_BRIDGE_MTLS_CLIENT_SHA256/);
    environment("3600");
    process.env.NATIVE_BRIDGE_HMAC_SECRET = "c2hvcnQ=";
    expect(() => getAuthConfig()).toThrow(/NATIVE_BRIDGE_HMAC_SECRET/);
    environment("3600");
    process.env.NATIVE_BRIDGE_HMAC_SECRET = process.env.SESSION_SECRET;
    expect(() => getAuthConfig()).toThrow(/must differ/);
    environment("3600");
    process.env.NATIVE_BRIDGE_HMAC_SECRET = process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => getAuthConfig()).toThrow(/must differ/);
  });
});
