// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { NextURL } from "next/dist/server/web/next-url";
import type { AuthConfig } from "@/server/auth/config";
import {
  OidcContractError,
  OidcProviderStageError,
  OAuth4WebApiProtocol,
  upstreamSessionBounds,
  validateAuthenticationTime,
} from "@/server/auth/oidc-protocol";
import discovery from "../../../tests/fixtures/keycloak-26.7.4-discovery.json";

const config = {
  appUrl: new URL("https://my.yildizskylab.com"),
  issuer: new URL("https://e.yildizskylab.com/realms/e-skylab"),
  clientId: "account-center",
  clientSecret: "client-secret-000000000000000000",
  ytuIdpAlias: "OBS",
} as AuthConfig;

afterEach(() => vi.unstubAllGlobals());

const signingKeys = generateKeyPair("RS256", { modulusLength: 2048 });

/**
 * Runs a real code exchange against a stubbed Keycloak whose ID token carries
 * `idClaims` next to the fixed identity claims, signed with a key the stubbed
 * JWKS publishes, so every claim reaches the protocol only through signature
 * validation.
 */
async function signedExchange(idClaims: Record<string, unknown>) {
  const keys = await signingKeys;
  const publicKey = await exportJWK(keys.publicKey);
  publicKey.kid = "exchange-test-key";
  const issuedAt = Math.floor(Date.now() / 1_000);
  const idToken = await new SignJWT({
    nonce: "nonce-value",
    sid: "keycloak-session",
    ...idClaims,
  })
    .setProtectedHeader({ alg: "RS256", kid: publicKey.kid, typ: "JWT" })
    .setIssuer(config.issuer.href)
    .setAudience(config.clientId)
    .setSubject("user-id")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(keys.privateKey);
  const accessToken = await new SignJWT({
    azp: config.clientId,
    scope: "openid",
    resource_access: {
      account: {
        roles: ["manage-account", "view-profile"],
      },
    },
  })
    .setProtectedHeader({ alg: "RS256", kid: publicKey.kid, typ: "JWT" })
    .setIssuer(config.issuer.href)
    .setAudience(["account", "core"])
    .setSubject("user-id")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(keys.privateKey);
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
}

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

  it("forces fresh authentication without any Keycloak account action", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.includes(".well-known")) return Response.json(discovery);
      return Response.json(
        { request_uri: "urn:ietf:params:oauth:request_uri:delete-reauth", expires_in: 45 },
        { status: 201 },
      );
    }));

    await new OAuth4WebApiProtocol(config).begin({
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
      forceReauthentication: true,
    });

    const pushed = requests.find(({ url }) => url === discovery.pushed_authorization_request_endpoint);
    const parameters = new URLSearchParams(pushed?.body);
    expect(parameters.get("prompt")).toBe("login");
    expect(parameters.get("max_age")).toBe("0");
    expect(parameters.get("scope")).toBe("openid");
    expect([...parameters.keys()].sort()).toEqual([
      "client_id", "code_challenge", "code_challenge_method", "max_age", "nonce", "prompt",
      "redirect_uri", "response_type", "scope", "state",
    ]);
    expect(pushed?.body).not.toContain("kc_action");
    expect(pushed?.body).not.toContain("DELETE_ACCOUNT");
  });

  it("keeps the YTÜ link action inside PAR without forcing a login and out of the browser URL", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.includes(".well-known")) return Response.json(discovery);
      return Response.json(
        { request_uri: "urn:ietf:params:oauth:request_uri:ytu-link", expires_in: 45 },
        { status: 201 },
      );
    }));

    const result = await new OAuth4WebApiProtocol(config).begin({
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
      accountAction: { action: "idp_link", parameter: "OBS" },
    });

    const pushed = requests.find(({ url }) => url === discovery.pushed_authorization_request_endpoint);
    const parameters = new URLSearchParams(pushed?.body);
    expect(parameters.get("kc_action")).toBe("idp_link");
    expect(parameters.get("kc_action_parameter")).toBe("OBS");
    expect(parameters.get("scope")).toBe("openid");
    expect(parameters.get("redirect_uri")).toBe("https://my.yildizskylab.com/api/auth/callback");
    expect([...parameters.keys()].sort()).toEqual([
      "client_id", "code_challenge", "code_challenge_method", "kc_action", "kc_action_parameter",
      "nonce", "redirect_uri", "response_type", "scope", "state",
    ]);
    expect(pushed?.body).not.toContain("prompt");
    expect(pushed?.body).not.toContain("max_age");
    expect(result.authorizationUrl.origin).toBe("https://e.yildizskylab.com");
    expect(result.authorizationUrl.searchParams.get("request_uri")).toBe("urn:ietf:params:oauth:request_uri:ytu-link");
    expect([...result.authorizationUrl.searchParams.keys()].sort()).toEqual(["client_id", "request_uri"]);
    expect(result.authorizationUrl.href).not.toContain("kc_action");
    expect(result.authorizationUrl.href).not.toContain("OBS");
  });

  it("refuses every account action but the configured YTÜ link before any request leaves", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(".well-known")) return Response.json(discovery);
      throw new Error("PAR must not be reached");
    });
    vi.stubGlobal("fetch", request);
    const protocol = new OAuth4WebApiProtocol(config);

    const rejected: Array<Partial<Parameters<typeof protocol.begin>[0]>> = [
      { accountAction: { action: "idp_link", parameter: "github" } },
      { accountAction: { action: "idp_link", parameter: "obs" } },
      { accountAction: { action: "idp_link", parameter: "OBS/../github" } },
      { accountAction: { action: "idp_link", parameter: "" } },
      { accountAction: { action: "UPDATE_PASSWORD" as "idp_link", parameter: "OBS" } },
      { accountAction: { action: "CONFIGURE_TOTP" as "idp_link", parameter: "OBS" } },
      { accountAction: { action: "delete_credential" as "idp_link", parameter: "OBS" } },
      { accountAction: { action: "DELETE_ACCOUNT" as "idp_link", parameter: "OBS" } },
      { accountAction: { action: "idp_link", parameter: "OBS" }, forceReauthentication: true },
    ];
    for (const input of rejected) {
      await expect(protocol.begin({
        state: "state-value",
        nonce: "nonce-value",
        codeVerifier: "v".repeat(43),
        ...input,
      })).rejects.toBeInstanceOf(OidcContractError);
    }
    expect(request).not.toHaveBeenCalled();

    // A deployment whose alias is not OBS accepts exactly its own alias.
    const sandbox = new OAuth4WebApiProtocol({ ...config, ytuIdpAlias: "obs-sandbox" });
    await expect(sandbox.begin({
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
      accountAction: { action: "idp_link", parameter: "OBS" },
    })).rejects.toBeInstanceOf(OidcContractError);
    expect(request).not.toHaveBeenCalled();
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

  describe("upstreamSessionBounds", () => {
    const now = new Date("2026-09-20T01:00:00Z");
    const authenticatedAt = new Date("2026-09-01T09:00:00Z");
    const seconds = (date: Date) => date.getTime() / 1_000;

    it("uses a sky_session_started between auth_time and now as the Keycloak session start", () => {
      for (const started of [
        authenticatedAt,
        new Date("2026-09-01T08:59:55Z"),
        new Date("2026-09-20T00:59:57Z"),
        new Date("2026-09-20T01:00:05Z"),
      ]) {
        expect(upstreamSessionBounds({ sky_session_started: seconds(started) }, authenticatedAt, now))
          .toEqual({ startedAt: started, claimIgnored: false });
      }
    });

    it("uses a sky_session_expires after auth_time and at most 31 days ahead as Keycloak's session end", () => {
      for (const expires of [
        new Date("2026-09-01T09:00:01Z"),
        new Date("2026-09-20T00:00:00Z"),
        new Date("2026-10-01T09:00:00Z"),
        new Date("2026-10-21T01:00:00Z"),
      ]) {
        expect(upstreamSessionBounds({ sky_session_expires: seconds(expires) }, authenticatedAt, now))
          .toEqual({ expiresAt: expires, claimIgnored: false });
      }
    });

    it("reads nothing and ignores nothing when the claims are absent", () => {
      expect(upstreamSessionBounds({}, authenticatedAt, now)).toEqual({ claimIgnored: false });
    });

    it("drops a sky_session_started before auth_time without calling it malformed", () => {
      // Normal after a prompt=login re-authentication inside a live Keycloak session.
      expect(upstreamSessionBounds({ sky_session_started: 1_788_253_194 }, authenticatedAt, now))
        .toEqual({ claimIgnored: false });
    });

    it.each([
      ["sky_session_started", "a string", "1789862400"],
      ["sky_session_started", "a fraction", 1_789_862_400.5],
      ["sky_session_started", "not a number", Number.NaN],
      ["sky_session_started", "infinite", Number.POSITIVE_INFINITY],
      ["sky_session_started", "negative", -1],
      ["sky_session_started", "in the future", 1_789_866_006],
      ["sky_session_started", "in milliseconds", 1_789_866_000_000],
      ["sky_session_expires", "a string", "1790000000"],
      ["sky_session_expires", "a fraction", 1_790_000_000.5],
      ["sky_session_expires", "at auth_time", 1_788_253_200],
      ["sky_session_expires", "before auth_time", 1_788_253_199],
      ["sky_session_expires", "more than 31 days ahead", 1_792_544_401],
      ["sky_session_expires", "in milliseconds", 1_790_000_000_000],
    ])("ignores %s when it is %s and says so", (claim, _label, value) => {
      expect(upstreamSessionBounds({ [claim]: value }, authenticatedAt, now)).toEqual({ claimIgnored: true });
    });
  });

  it("accepts auth_time only from a signature-validated ID token", async () => {
    const issuedAt = Math.floor(Date.now() / 1_000);

    await expect(signedExchange({ auth_time: issuedAt - 60 })).resolves.toMatchObject({
      subject: "user-id",
      authenticatedAt: new Date((issuedAt - 60) * 1_000),
    });
    await expect(signedExchange({})).rejects.toBeInstanceOf(OidcContractError);
  });

  it("reads the Keycloak session start and the SkyApp marker from the signature-validated ID token", async () => {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const appLogin = issuedAt - 20 * 24 * 60 * 60;

    const handoff = await signedExchange({
      auth_time: appLogin,
      sky_session_started: issuedAt - 3,
      sky_embed: "skyapp",
    });
    expect(handoff.authenticatedAt).toEqual(new Date(appLogin * 1_000));
    expect(handoff.upstreamSessionStartedAt).toEqual(new Date((issuedAt - 3) * 1_000));
    expect(handoff.embeddedApp).toBe("skyapp");

    const plain = await signedExchange({ auth_time: issuedAt - 60 });
    expect(plain).not.toHaveProperty("upstreamSessionStartedAt");
    expect(plain).not.toHaveProperty("upstreamSessionExpiresAt");
    expect(plain).not.toHaveProperty("embeddedApp");
    expect(plain).not.toHaveProperty("sessionClaimIgnored");
  });

  it("reads Keycloak's own session end from the signature-validated ID token", async () => {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const rememberedLogin = issuedAt - 20 * 24 * 60 * 60;

    const remembered = await signedExchange({
      auth_time: rememberedLogin,
      sky_session_started: rememberedLogin,
      sky_session_expires: rememberedLogin + 30 * 24 * 60 * 60,
    });
    expect(remembered.upstreamSessionExpiresAt).toEqual(new Date((rememberedLogin + 30 * 24 * 60 * 60) * 1_000));
    expect(remembered).not.toHaveProperty("sessionClaimIgnored");
  });

  it("reports a malformed session claim it ignored without passing its value on", async () => {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const result = await signedExchange({ auth_time: issuedAt - 60, sky_session_expires: "soon" });
    expect(result.sessionClaimIgnored).toBe(true);
    expect(result).not.toHaveProperty("upstreamSessionExpiresAt");
    expect(JSON.stringify({ ...result, tokens: undefined })).not.toContain("soon");
  });

  it.each([
    ["another app", "otherapp"],
    ["a different case", "SkyApp"],
    ["a boolean", true],
    ["an array", ["skyapp"]],
  ])("does not treat sky_embed with %s as SkyApp", async (_label, value) => {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const result = await signedExchange({ auth_time: issuedAt - 60, sky_embed: value });
    expect(result).not.toHaveProperty("embeddedApp");
  });

  it("classifies callback validation failures without exposing authorization material", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(".well-known")) return Response.json(discovery);
      throw new Error(`Unexpected request: ${url}`);
    }));

    const callbackUrl = new URL("https://my.yildizskylab.com/api/auth/callback");
    callbackUrl.searchParams.set("state", "different-state");
    callbackUrl.searchParams.set("iss", config.issuer.href);

    const exchange = new OAuth4WebApiProtocol(config).exchange({
      callbackUrl,
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
    });

    await expect(exchange).rejects.toMatchObject({
      name: "OidcProviderStageError",
      stage: "authorization_response",
      message: "The OIDC provider failed during authorization_response.",
    } satisfies Partial<OidcProviderStageError>);
  });

  it("accepts the NextURL instance supplied by a NextRequest callback", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(".well-known")) return Response.json(discovery);
      if (url === discovery.token_endpoint) throw new Error("token transport reached");
      throw new Error(`Unexpected request: ${url}`);
    }));

    const callbackUrl = new NextURL("https://my.yildizskylab.com/api/auth/callback");
    callbackUrl.searchParams.set("code", "authorization-code");
    callbackUrl.searchParams.set("state", "state-value");
    callbackUrl.searchParams.set("iss", config.issuer.href);

    const exchange = new OAuth4WebApiProtocol(config).exchange({
      callbackUrl: callbackUrl as unknown as URL,
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
    });

    await expect(exchange).rejects.toMatchObject({
      name: "OidcProviderStageError",
      stage: "token_request",
    } satisfies Partial<OidcProviderStageError>);
  });

  it("classifies token endpoint transport failures without logging the code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(".well-known")) return Response.json(discovery);
      if (url === discovery.token_endpoint) throw new Error("transport included sensitive material");
      throw new Error(`Unexpected request: ${url}`);
    }));

    const callbackUrl = new URL("https://my.yildizskylab.com/api/auth/callback");
    callbackUrl.searchParams.set("code", "authorization-code");
    callbackUrl.searchParams.set("state", "state-value");
    callbackUrl.searchParams.set("iss", config.issuer.href);

    const exchange = new OAuth4WebApiProtocol(config).exchange({
      callbackUrl,
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "v".repeat(43),
    });

    await expect(exchange).rejects.toMatchObject({
      name: "OidcProviderStageError",
      stage: "token_request",
      message: "The OIDC provider failed during token_request.",
    } satisfies Partial<OidcProviderStageError>);
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
