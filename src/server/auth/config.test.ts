import { afterEach, describe, expect, it } from "vitest";
import { getAuthConfig } from "@/server/auth/config";
import { trustedClientAddress } from "@/server/auth/rate-limit";
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

  it("keeps account erasure off unless an exact Core origin is explicitly enabled", () => {
    environment("3600");
    expect(getAuthConfig().accountErasure).toEqual({ mode: "off" });
    process.env.ACCOUNT_ERASURE_MODE = "enforce";
    process.env.ACCOUNT_ACCESS_GATE_MODE = "enforce";
    expect(() => getAuthConfig()).toThrow(/CORE_API_URL/);
    process.env.CORE_API_URL = "https://api.yildizskylab.com";
    expect(getAuthConfig().accountErasure).toEqual({
      mode: "enforce",
      coreApiUrl: new URL("https://api.yildizskylab.com"),
    });
  });

  it("accepts exactly the three documented edge topologies", () => {
    environment("3600");
    expect(getAuthConfig().trustedProxy).toBe("cloudflare");
    for (const mode of ["traefik", "none"] as const) {
      process.env.AUTH_TRUSTED_PROXY = mode;
      expect(getAuthConfig().trustedProxy).toBe(mode);
    }
    for (const invalid of ["", "  ", "x-forwarded-for", "Traefik", "traefik,none", "<proxy>"]) {
      process.env.AUTH_TRUSTED_PROXY = invalid;
      expect(() => getAuthConfig()).toThrow(/AUTH_TRUSTED_PROXY/);
    }
  });

  it("defaults the trusted proxy ranges to the private networks and rejects a loose override", () => {
    environment("3600");
    process.env.AUTH_TRUSTED_PROXY = "traefik";
    const request = { headers: new Headers({ "x-forwarded-for": "203.0.113.42, 10.0.1.109" }) };
    expect(getAuthConfig().trustedProxyRanges).toHaveLength(6);
    expect(
      trustedClientAddress(request, "traefik", getAuthConfig().trustedProxyRanges),
    ).toBe("203.0.113.42");

    // Narrowing the set turns a former hop back into a client address of its own.
    process.env.AUTH_TRUSTED_PROXY_RANGES = " 192.168.0.0/16 , ::1/128 ";
    expect(getAuthConfig().trustedProxyRanges).toHaveLength(2);
    expect(
      trustedClientAddress(request, "traefik", getAuthConfig().trustedProxyRanges),
    ).toBe("10.0.1.109");

    for (const invalid of ["10.0.0.1/8", "10.0.0.0", "10.0.0.0/33", "fe80::1%eth0/64", ",", "private"]) {
      process.env.AUTH_TRUSTED_PROXY_RANGES = invalid;
      expect(() => getAuthConfig()).toThrow(/AUTH_TRUSTED_PROXY_RANGES/);
    }
  });

  it("defaults the YTÜ identity provider alias to OBS and accepts only a URL-safe alias", () => {
    environment("3600");
    expect(getAuthConfig().ytuIdpAlias).toBe("OBS");
    process.env.YTU_IDP_ALIAS = " obs-sandbox_2 ";
    expect(getAuthConfig().ytuIdpAlias).toBe("obs-sandbox_2");
    for (const invalid of ["OBS/link", "OBS OBS", "a".repeat(65), "<idp-alias>", "OBS?x=1", "ÖBS"]) {
      process.env.YTU_IDP_ALIAS = invalid;
      expect(() => getAuthConfig()).toThrow(/YTU_IDP_ALIAS/);
    }
  });

  it("keeps the club-profile core origin optional but canonical whenever it is set", () => {
    environment("3600");
    expect(getAuthConfig().coreApiUrl).toBeNull();
    process.env.CORE_API_URL = "https://api.yildizskylab.com";
    expect(getAuthConfig().coreApiUrl).toEqual(new URL("https://api.yildizskylab.com"));
    expect(getAuthConfig().accountErasure).toEqual({ mode: "off" });
    for (const invalid of [
      "http://api.yildizskylab.com",
      "https://api.yildizskylab.com/v1",
      "https://user:secret@api.yildizskylab.com",
      "https://api.yildizskylab.com/?x=1",
      "https://API.yildizskylab.com",
    ]) {
      process.env.CORE_API_URL = invalid;
      expect(() => getAuthConfig()).toThrow(/CORE_API_URL/);
    }
  });
});
