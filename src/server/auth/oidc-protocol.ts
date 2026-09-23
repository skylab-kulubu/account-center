import "server-only";

import * as oauth from "oauth4webapi";
import type { AuthConfig } from "@/server/auth/config";
import { oidcRedirectUri, YTU_IDP_ALIAS_PATTERN } from "@/server/auth/config";
import type { OidcTokenSet } from "@/server/auth/types";
import { validateAccountAccessToken } from "@/server/keycloak-account/access-token";

/**
 * The one Keycloak application-initiated action Account Center still requests:
 * `kc_action=idp_link` with `kc_action_parameter=<YTÜ IdP alias>`, which links
 * the person's YTÜ Microsoft account. Linking needs a login at Microsoft, so it
 * cannot run inside `my.`; every other account action goes through the
 * sky-account SPI and is refused here before any request leaves.
 */
export type OidcAccountAction = { action: "idp_link"; parameter: string };

export type BeginAuthorizationInput = {
  state: string;
  nonce: string;
  codeVerifier: string;
  nativeBridgeCode?: string;
  /** `prompt=login&max_age=0`: the Microsoft re-authentication used by Sudo mode's fallback and account deletion. */
  forceReauthentication?: boolean;
  /** Only the YTÜ link (`idp_link` for the configured alias); never combined with the bridge or a forced login. */
  accountAction?: OidcAccountAction;
};

export type ExchangeAuthorizationInput = BeginAuthorizationInput & {
  callbackUrl: URL;
};

export type AuthorizationResult = {
  subject: string;
  keycloakSid?: string;
  authenticatedAt: Date;
  /**
   * When the Keycloak session behind these tokens began (`sky_session_started`),
   * if the ID token says so sanely. A Web handoff opens a fresh Keycloak
   * session that carries the app's original `auth_time`; absent, the session
   * is taken to have begun at `authenticatedAt`.
   */
  upstreamSessionStartedAt?: Date;
  /** `sky_session_expires`: when Keycloak itself ends that session, if the ID token says so sanely. */
  upstreamSessionExpiresAt?: Date;
  /** A `sky_session_*` claim was present but malformed and was dropped. */
  sessionClaimIgnored?: true;
  /** `sky_embed`: a Web handoff opened this session inside SkyApp's WebView. */
  embeddedApp?: "skyapp";
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

export type OidcProviderStage =
  | "discovery"
  | "authorization_response"
  | "token_request"
  | "token_response"
  | "id_token_signature";

export class OidcProviderStageError extends Error {
  constructor(readonly stage: OidcProviderStage) {
    super(`The OIDC provider failed during ${stage}.`);
    this.name = "OidcProviderStageError";
  }
}

/** A claim in whole epoch seconds that is not in the future (5 s of clock skew allowed). */
function isPastEpochSeconds(value: unknown, now: Date): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Math.floor(now.getTime() / 1_000) + 5
  );
}

export function validateAuthenticationTime(
  claims: Record<string, unknown>,
  now: Date = new Date(),
) {
  const value = claims.auth_time;
  if (!isPastEpochSeconds(value, now)) {
    throw new OidcContractError("OIDC ID token has no valid auth_time.");
  }
  return new Date(value * 1_000);
}

const MAX_UPSTREAM_SESSION_AHEAD_SECONDS = 31 * 24 * 60 * 60;

/**
 * The Keycloak session behind a login, from the verified `sky_session_*`
 * claims of the SKY LAB mapper on `account-center`:
 *
 * - `expiresAt` (`sky_session_expires`): when Keycloak ends the session,
 *   remember-me and client overrides included; after `auth_time` and at most
 *   31 days ahead. A past value is kept: the session has already ended.
 * - `startedAt` (`sky_session_started`): when the session began; in the past
 *   and not before `auth_time` (5 s of clock skew either way). An earlier
 *   value is normal after a `prompt=login` re-authentication inside a live
 *   session, which keeps its start but moves `auth_time`; it is dropped and
 *   the cap keeps starting at `auth_time`.
 *
 * `claimIgnored` says a present claim was malformed (wrong type, fraction,
 * out of range) and dropped, so a broken mapper shows up in the logs.
 */
export function upstreamSessionBounds(
  claims: Record<string, unknown>,
  authenticatedAt: Date,
  now: Date = new Date(),
): { startedAt?: Date; expiresAt?: Date; claimIgnored: boolean } {
  let claimIgnored = false;
  const bounds: { startedAt?: Date; expiresAt?: Date } = {};

  const started = claims.sky_session_started;
  if (isPastEpochSeconds(started, now)) {
    if (started * 1_000 >= authenticatedAt.getTime() - 5_000) bounds.startedAt = new Date(started * 1_000);
  } else if (started !== undefined) {
    claimIgnored = true;
  }

  const expires = claims.sky_session_expires;
  if (
    typeof expires === "number" &&
    Number.isSafeInteger(expires) &&
    expires * 1_000 > authenticatedAt.getTime() &&
    expires <= Math.floor(now.getTime() / 1_000) + MAX_UPSTREAM_SESSION_AHEAD_SECONDS
  ) {
    bounds.expiresAt = new Date(expires * 1_000);
  } else if (expires !== undefined) {
    claimIgnored = true;
  }

  return { ...bounds, claimIgnored };
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
    // A native bridge login is never a forced re-authentication: the bridge
    // carries the original `auth_time`, which the callback verifies unchanged.
    if (input.nativeBridgeCode !== undefined && input.forceReauthentication === true) {
      throw new OidcContractError("OIDC native handoff cannot request a forced re-authentication.");
    }
    // The YTÜ link is the only account action, for the configured alias only,
    // and stands alone: linking re-authenticates at Microsoft by itself, so no
    // `prompt=login` is added, and a bridge login never carries an action.
    if (
      input.accountAction !== undefined &&
      (
        input.accountAction.action !== "idp_link" ||
        !YTU_IDP_ALIAS_PATTERN.test(input.accountAction.parameter) ||
        input.accountAction.parameter !== this.config.ytuIdpAlias ||
        input.nativeBridgeCode !== undefined ||
        input.forceReauthentication === true
      )
    ) {
      throw new OidcContractError("OIDC account action is outside the YTÜ link allowlist.");
    }
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
    if (input.forceReauthentication) {
      parameters.set("max_age", "0");
      parameters.set("prompt", "login");
    }
    if (input.accountAction) {
      parameters.set("kc_action", input.accountAction.action);
      parameters.set("kc_action_parameter", input.accountAction.parameter);
    }
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
    let authorizationServer: oauth.AuthorizationServer;
    try {
      authorizationServer = await this.#authorizationServer();
    } catch (error) {
      if (error instanceof OidcContractError) throw error;
      throw new OidcProviderStageError("discovery");
    }

    let parameters: URLSearchParams;
    try {
      parameters = oauth.validateAuthResponse(
        authorizationServer,
        this.#client,
        new URLSearchParams(input.callbackUrl.search),
        input.state,
      );
    } catch {
      throw new OidcProviderStageError("authorization_response");
    }

    let response: Response;
    try {
      response = await oauth.authorizationCodeGrantRequest(
        authorizationServer,
        this.#client,
        this.#clientAuthentication,
        parameters,
        oidcRedirectUri(this.config),
        input.codeVerifier,
        { [oauth.customFetch]: timeoutFetch },
      );
    } catch {
      throw new OidcProviderStageError("token_request");
    }

    let tokens: oauth.TokenEndpointResponse;
    try {
      tokens = await oauth.processAuthorizationCodeResponse(
        authorizationServer,
        this.#client,
        response,
        { expectedNonce: input.nonce, requireIdToken: true },
      );
    } catch {
      throw new OidcProviderStageError("token_response");
    }

    try {
      await oauth.validateApplicationLevelSignature(authorizationServer, response, {
        [oauth.customFetch]: timeoutFetch,
      });
    } catch {
      throw new OidcProviderStageError("id_token_signature");
    }
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    if (!claims?.sub || !tokens.id_token) throw new OidcContractError("OIDC response has no usable identity.");
    const authenticatedAt = validateAuthenticationTime(claims);
    const upstreamSession = upstreamSessionBounds(claims, authenticatedAt);
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
      ...(upstreamSession.startedAt ? { upstreamSessionStartedAt: upstreamSession.startedAt } : {}),
      ...(upstreamSession.expiresAt ? { upstreamSessionExpiresAt: upstreamSession.expiresAt } : {}),
      ...(upstreamSession.claimIgnored ? { sessionClaimIgnored: true as const } : {}),
      ...(claims.sky_embed === "skyapp" ? { embeddedApp: "skyapp" as const } : {}),
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
