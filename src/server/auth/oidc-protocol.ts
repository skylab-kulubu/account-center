import "server-only";

import * as oauth from "oauth4webapi";
import type { AuthConfig } from "@/server/auth/config";
import { oidcRedirectUri } from "@/server/auth/config";
import type { OidcTokenSet } from "@/server/auth/types";
import { validateAccountAccessToken } from "@/server/keycloak-account/access-token";

export type BeginAuthorizationInput = {
  state: string;
  nonce: string;
  codeVerifier: string;
  nativeBridgeCode?: string;
};

export type ExchangeAuthorizationInput = BeginAuthorizationInput & {
  callbackUrl: URL;
};

export type AuthorizationResult = {
  subject: string;
  keycloakSid?: string;
  authenticatedAt: Date;
  tokens: OidcTokenSet;
};

export interface OidcProtocol {
  begin(input: BeginAuthorizationInput): Promise<{ authorizationUrl: URL; expiresIn: number }>;
  exchange(input: ExchangeAuthorizationInput): Promise<AuthorizationResult>;
  refresh(tokens: OidcTokenSet): Promise<OidcTokenSet>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
}

export class OidcContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcContractError";
  }
}

export function validateAuthenticationTime(
  claims: Record<string, unknown>,
  now: Date = new Date(),
) {
  const value = claims.auth_time;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Math.floor(now.getTime() / 1_000) + 5
  ) {
    throw new OidcContractError("OIDC ID token has no valid auth_time.");
  }
  return new Date(value * 1_000);
}

function requiredEndpoint(metadata: oauth.AuthorizationServer, field: keyof oauth.AuthorizationServer) {
  const value = metadata[field];
  if (typeof value !== "string") throw new OidcContractError(`OIDC metadata is missing ${String(field)}.`);
  return new URL(value);
}

export function validateOidcMetadataContract(metadata: oauth.AuthorizationServer, config: Pick<AuthConfig, "issuer">) {
  if (metadata.issuer !== config.issuer.href.replace(/\/$/, "")) {
    throw new OidcContractError("OIDC issuer does not match the configured issuer.");
  }

  const issuerPath = config.issuer.pathname.replace(/\/$/, "");
  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "pushed_authorization_request_endpoint",
    "revocation_endpoint",
  ] as const) {
    const endpoint = requiredEndpoint(metadata, field);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.origin !== config.issuer.origin ||
      !endpoint.pathname.startsWith(`${issuerPath}/`)
    ) {
      throw new OidcContractError(`OIDC ${field} is outside the configured HTTPS realm.`);
    }
  }

  if (metadata.code_challenge_methods_supported?.includes("S256") !== true) {
    throw new OidcContractError("OIDC provider must advertise S256 PKCE.");
  }
  if (metadata.response_types_supported?.includes("code") !== true) {
    throw new OidcContractError("OIDC provider must support the authorization code response type.");
  }
  if (metadata.grant_types_supported?.includes("authorization_code") !== true) {
    throw new OidcContractError("OIDC provider must support the authorization_code grant.");
  }
  if (metadata.token_endpoint_auth_methods_supported?.includes("client_secret_basic") !== true) {
    throw new OidcContractError("OIDC provider must support client_secret_basic.");
  }
}

function timeoutFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
}

export class OAuth4WebApiProtocol implements OidcProtocol {
  readonly #client: oauth.Client;
  readonly #clientAuthentication: oauth.ClientAuth;
  #metadata?: { value: oauth.AuthorizationServer; expiresAt: number };

  constructor(private readonly config: AuthConfig) {
    this.#client = {
      client_id: config.clientId,
      id_token_signed_response_alg: "RS256",
    };
    this.#clientAuthentication = oauth.ClientSecretBasic(config.clientSecret);
  }

  async #authorizationServer() {
    if (this.#metadata && this.#metadata.expiresAt > Date.now()) return this.#metadata.value;
    const response = await oauth.discoveryRequest(this.config.issuer, {
      [oauth.customFetch]: timeoutFetch,
    });
    const metadata = await oauth.processDiscoveryResponse(this.config.issuer, response);
    validateOidcMetadataContract(metadata, this.config);
    this.#metadata = { value: metadata, expiresAt: Date.now() + 5 * 60 * 1_000 };
    return metadata;
  }

  async begin(input: BeginAuthorizationInput) {
    const authorizationServer = await this.#authorizationServer();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(input.codeVerifier);
    const parameters = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: oidcRedirectUri(this.config),
      response_type: "code",
      scope: "openid",
      state: input.state,
      nonce: input.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    if (input.nativeBridgeCode) parameters.set("sky_native_handoff", input.nativeBridgeCode);
    const response = await oauth.pushedAuthorizationRequest(
      authorizationServer,
      this.#client,
      this.#clientAuthentication,
      parameters,
      { [oauth.customFetch]: timeoutFetch },
    );
    const pushed = await oauth.processPushedAuthorizationResponse(
      authorizationServer,
      this.#client,
      response,
    );
    const authorizationEndpoint = requiredEndpoint(authorizationServer, "authorization_endpoint");
    authorizationEndpoint.search = new URLSearchParams({
      client_id: this.config.clientId,
      request_uri: pushed.request_uri,
    }).toString();
    return { authorizationUrl: authorizationEndpoint, expiresIn: pushed.expires_in };
  }

  async exchange(input: ExchangeAuthorizationInput) {
    const authorizationServer = await this.#authorizationServer();
    const parameters = oauth.validateAuthResponse(
      authorizationServer,
      this.#client,
      input.callbackUrl,
      input.state,
    );
    const response = await oauth.authorizationCodeGrantRequest(
      authorizationServer,
      this.#client,
      this.#clientAuthentication,
      parameters,
      oidcRedirectUri(this.config),
      input.codeVerifier,
      { [oauth.customFetch]: timeoutFetch },
    );
    const tokens = await oauth.processAuthorizationCodeResponse(
      authorizationServer,
      this.#client,
      response,
      { expectedNonce: input.nonce, requireIdToken: true },
    );
    await oauth.validateApplicationLevelSignature(authorizationServer, response, {
      [oauth.customFetch]: timeoutFetch,
    });
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    if (!claims?.sub || !tokens.id_token) throw new OidcContractError("OIDC response has no usable identity.");
    const authenticatedAt = validateAuthenticationTime(claims);
    const keycloakSid = typeof claims.sid === "string" ? claims.sid : undefined;
    try {
      if (tokens.token_type !== "bearer") throw new Error("unsupported token type");
      validateAccountAccessToken(tokens.access_token, {
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        subject: claims.sub,
      });
    } catch {
      throw new OidcContractError("OIDC access token does not match the Account REST contract.");
    }
    return {
      subject: claims.sub,
      ...(keycloakSid ? { keycloakSid } : {}),
      authenticatedAt,
      tokens: {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        idToken: tokens.id_token,
        tokenType: tokens.token_type,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        ...(tokens.expires_in ? { expiresAt: Math.floor(Date.now() / 1_000) + tokens.expires_in } : {}),
      },
    };
  }

  async refresh(current: OidcTokenSet) {
    if (!current.refreshToken) throw new OidcContractError("OIDC session has no refresh token.");
    const authorizationServer = await this.#authorizationServer();
    const response = await oauth.refreshTokenGrantRequest(
      authorizationServer,
      this.#client,
      this.#clientAuthentication,
      current.refreshToken,
      { [oauth.customFetch]: timeoutFetch },
    );
    const tokens = await oauth.processRefreshTokenResponse(
      authorizationServer,
      this.#client,
      response,
    );
    if (tokens.token_type !== "bearer") {
      throw new OidcContractError("OIDC refresh returned an unsupported access token type.");
    }
    if (tokens.id_token) {
      await oauth.validateApplicationLevelSignature(authorizationServer, response, {
        [oauth.customFetch]: timeoutFetch,
      });
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? current.refreshToken,
      // Keep the signature-validated login ID token and its original auth_time.
      // Refreshed identity claims never extend the local absolute session cap.
      idToken: current.idToken,
      tokenType: tokens.token_type,
      ...(tokens.scope ? { scope: tokens.scope } : current.scope ? { scope: current.scope } : {}),
      ...(tokens.expires_in
        ? { expiresAt: Math.floor(Date.now() / 1_000) + tokens.expires_in }
        : {}),
    };
  }

  async revokeRefreshToken(refreshToken: string) {
    const authorizationServer = await this.#authorizationServer();
    const response = await oauth.revocationRequest(
      authorizationServer,
      this.#client,
      this.#clientAuthentication,
      refreshToken,
      {
        additionalParameters: { token_type_hint: "refresh_token" },
        [oauth.customFetch]: timeoutFetch,
      },
    );
    await oauth.processRevocationResponse(response);
  }
}
