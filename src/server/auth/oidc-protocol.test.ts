// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AuthConfig } from "@/server/auth/config";
import {
  OidcContractError,
  OAuth4WebApiProtocol,
  validateAuthenticationTime,
} from "@/server/auth/oidc-protocol";
import discovery from "../../../tests/fixtures/keycloak-26.7.4-discovery.json";

const config = {
  appUrl: new URL("https://my.yildizskylab.com"),
  issuer: new URL("https://e.yildizskylab.com/realms/e-skylab"),
  clientId: "account-center",
  clientSecret: "client-secret-000000000000000000",
} as AuthConfig;

afterEach(() => vi.unstubAllGlobals());

describe("OAuth4WebApiProtocol", () => {
  it("sends the minimal exact openid scope in its pushed authorization request", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({
        url,
        ...(init?.body ? { body: String(init.body) } : {}),
      });
      if (url.includes(".well-known")) {
        return Response.json(discovery);
      }
      return Response.json(
        { request_uri: "urn:ietf:params:oauth:request_uri:test", expires_in: 90 },
        { status: 201 },
      );
    }));

    await new OAuth4WebApiProtocol(config).begin({
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
    });

    const pushed = requests.find(({ url }) => url === discovery.pushed_authorization_request_endpoint);
    expect(new URLSearchParams(pushed?.body).getAll("scope")).toEqual(["openid"]);
  });

  it("keeps the native bridge hint inside PAR and out of the browser authorization URL", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.includes(".well-known")) return Response.json(discovery);
      return Response.json(
        { request_uri: "urn:ietf:params:oauth:request_uri:native", expires_in: 45 },
        { status: 201 },
      );
    }));

    const result = await new OAuth4WebApiProtocol(config).begin({
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
      nativeBridgeCode: "opaque-bridge-hint",
    });

    const pushed = requests.find(({ url }) => url === discovery.pushed_authorization_request_endpoint);
    expect(new URLSearchParams(pushed?.body).get("sky_native_handoff")).toBe("opaque-bridge-hint");
    expect(result.authorizationUrl.searchParams.get("request_uri")).toBe(
      "urn:ietf:params:oauth:request_uri:native",
    );
    expect([...result.authorizationUrl.searchParams.keys()].sort()).toEqual([
      "client_id",
      "request_uri",
    ]);
    expect(result.authorizationUrl.searchParams.get("sky_native_handoff")).toBeNull();
    expect(result.authorizationUrl.href).not.toContain("opaque-bridge-hint");
  });

  it("requires a sane auth_time from the verified ID-token claims", () => {
    const now = new Date("2026-09-20T01:00:00Z");
    expect(
      validateAuthenticationTime({ auth_time: 1_789_862_400 }, now),
    ).toEqual(new Date("2026-09-20T00:00:00Z"));
    for (const claims of [
      {},
      { auth_time: "1789862400" },
      { auth_time: 1_789_862_400.5 },
      { auth_time: 1_789_866_006 },
    ]) {
      expect(() => validateAuthenticationTime(claims, now)).toThrow(/auth_time/);
    }
  });

  it("accepts auth_time only from a signature-validated ID token", async () => {
    const keys = await generateKeyPair("RS256", { modulusLength: 2048 });
    const publicKey = await exportJWK(keys.publicKey);
    publicKey.kid = "exchange-test-key";
    const issuedAt = Math.floor(Date.now() / 1_000);
    const makeIdToken = (includeAuthTime: boolean) => new SignJWT({
      nonce: "nonce-value",
      sid: "keycloak-session",
      ...(includeAuthTime ? { auth_time: issuedAt - 60 } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: publicKey.kid, typ: "JWT" })
      .setIssuer(config.issuer.href)
      .setAudience(config.clientId)
      .setSubject("user-id")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(keys.privateKey);
    const makeAccessToken = () => new SignJWT({
      azp: config.clientId,
      scope: "openid",
    })
      .setProtectedHeader({ alg: "RS256", kid: publicKey.kid, typ: "JWT" })
      .setIssuer(config.issuer.href)
      .setAudience("account")
      .setSubject("user-id")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(keys.privateKey);

    const exchange = async (includeAuthTime: boolean) => {
      const idToken = await makeIdToken(includeAuthTime);
      const accessToken = await makeAccessToken();
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes(".well-known")) return Response.json(discovery);
        if (url === discovery.token_endpoint) {
          return Response.json({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 300,
            id_token: idToken,
          });
        }
        if (url === discovery.jwks_uri) return Response.json({ keys: [publicKey] });
        throw new Error(`Unexpected OIDC request: ${url}`);
      }));
      const callbackUrl = new URL("https://my.yildizskylab.com/api/auth/callback");
      callbackUrl.searchParams.set("code", "authorization-code");
      callbackUrl.searchParams.set("state", "state-value");
      callbackUrl.searchParams.set("iss", config.issuer.href);
      return new OAuth4WebApiProtocol(config).exchange({
        callbackUrl,
        state: "state-value",
        nonce: "nonce-value",
        codeVerifier: "v".repeat(43),
      });
    };

    await expect(exchange(true)).resolves.toMatchObject({
      subject: "user-id",
      authenticatedAt: new Date((issuedAt - 60) * 1_000),
    });
    await expect(exchange(false)).rejects.toBeInstanceOf(OidcContractError);
  });

  it("refreshes with the confidential client and preserves the original verified ID token", async () => {
    const requests: Array<{ url: string; body?: string; authorization?: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        ...(init?.body ? { body: String(init.body) } : {}),
        authorization: headers.get("authorization"),
      });
      if (url.includes(".well-known")) return Response.json(discovery);
      if (url === discovery.token_endpoint) {
        return Response.json({
          access_token: "refreshed-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const refreshed = await new OAuth4WebApiProtocol(config).refresh({
      accessToken: "expired-access-token",
      refreshToken: "server-only-refresh-token",
      idToken: "original-verified-id-token",
      tokenType: "bearer",
      scope: "openid",
    });
    expect(refreshed).toMatchObject({
      accessToken: "refreshed-access-token",
      refreshToken: "rotated-refresh-token",
      idToken: "original-verified-id-token",
      scope: "openid",
    });
    const tokenRequest = requests.find(({ url }) => url === discovery.token_endpoint);
    expect(new URLSearchParams(tokenRequest?.body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(tokenRequest?.body).get("refresh_token")).toBe("server-only-refresh-token");
    expect(tokenRequest?.authorization).toMatch(/^Basic /);
  });
});
