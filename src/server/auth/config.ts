import "server-only";

import {
  AUTH_TRUSTED_PROXY_MODES,
  DEFAULT_TRUSTED_PROXY_RANGES,
  parseTrustedProxyRanges,
} from "@/server/auth/trusted-proxy";
import type { AuthTrustedProxy, TrustedProxyRange } from "@/server/auth/trusted-proxy";

export type AuthConfig = {
  appUrl: URL;
  issuer: URL;
  clientId: string;
  clientSecret: string;
  upstreamSessionMaxSeconds: number;
  /** Which edge this deployment reads the visitor address from; see `docs/auth-edge-trust.md`. */
  trustedProxy: AuthTrustedProxy;
  /**
   * CIDR blocks that are skipped as proxy hops while reading `X-Forwarded-For`
   * in `traefik` mode. Every peer inside the set may present a client address.
   */
  trustedProxyRanges: readonly TrustedProxyRange[];
  databaseUrl: string;
  sessionHmacKey: Buffer;
  tokenEncryptionKey: Buffer;
  oidcTransactionTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  sessionRotationSeconds: number;
  previousHandleGraceSeconds: number;
  /** Canonical core origin for the person's own `/v1/users/me` endpoints; `null` keeps club-profile features off. */
  coreApiUrl: URL | null;
  accountErasure:
    | { mode: "off" }
    | { mode: "enforce"; coreApiUrl: URL };
  /**
   * Keycloak alias of the YTÜ Microsoft identity provider (`YTU_IDP_ALIAS`,
   * default `OBS`): the only `kc_action_parameter` the `idp_link`
   * application-initiated action may carry.
   */
  ytuIdpAlias: string;
};

/** A Keycloak identity provider alias as this deployment accepts it: one URL-safe path segment. */
export const YTU_IDP_ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_YTU_IDP_ALIAS = "OBS";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

function decodeKey(name: string, expectedLength?: number) {
  const value = required(name).replace(/-/g, "+").replace(/_/g, "/");
  const key = Buffer.from(`${value}${"=".repeat((4 - (value.length % 4)) % 4)}`, "base64");
  if (key.length < 32 || (expectedLength !== undefined && key.length !== expectedLength)) {
    throw new Error(`Invalid server key: ${name}`);
  }
  return key;
}

function httpsUrl(name: string) {
  let url: URL;
  try {
    url = new URL(required(name));
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS.`);
  return url;
}

function oidcIssuer() {
  const value = required("OIDC_ISSUER");
  const url = httpsUrl("OIDC_ISSUER");
  const realmPath = /^\/realms\/[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !realmPath.test(url.pathname) ||
    value !== `${url.origin}${url.pathname}`
  ) {
    throw new Error("OIDC_ISSUER must be a canonical credential-free Keycloak realm HTTPS URL.");
  }
  return url;
}

function integer(name: string, minimum: number, maximum: number) {
  const value = required(name);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the safe range.`);
  }
  return parsed;
}

function coreApiUrlConfig(): URL | null {
  if (!process.env.CORE_API_URL?.trim()) return null;
  const value = required("CORE_API_URL");
  const coreApiUrl = httpsUrl("CORE_API_URL");
  if (
    coreApiUrl.username ||
    coreApiUrl.password ||
    coreApiUrl.pathname !== "/" ||
    coreApiUrl.search ||
    coreApiUrl.hash ||
    value !== coreApiUrl.origin
  ) {
    throw new Error("CORE_API_URL must be a canonical credential-free HTTPS origin.");
  }
  return coreApiUrl;
}

function trustedProxyConfig(): AuthTrustedProxy {
  const value = required("AUTH_TRUSTED_PROXY");
  const mode = AUTH_TRUSTED_PROXY_MODES.find((candidate) => candidate === value);
  if (!mode) {
    throw new Error("AUTH_TRUSTED_PROXY must be cloudflare, traefik or none.");
  }
  return mode;
}

function trustedProxyRangesConfig(): readonly TrustedProxyRange[] {
  const value = process.env.AUTH_TRUSTED_PROXY_RANGES?.trim() || DEFAULT_TRUSTED_PROXY_RANGES;
  const ranges = parseTrustedProxyRanges(value);
  if (!ranges) {
    throw new Error(
      "AUTH_TRUSTED_PROXY_RANGES must be a comma-separated list of canonical CIDR blocks.",
    );
  }
  return ranges;
}

function ytuIdpAliasConfig() {
  const value = process.env.YTU_IDP_ALIAS?.trim();
  if (!value) return DEFAULT_YTU_IDP_ALIAS;
  if (!YTU_IDP_ALIAS_PATTERN.test(value)) {
    throw new Error("YTU_IDP_ALIAS must be a Keycloak identity provider alias of 1–64 URL-safe characters.");
  }
  return value;
}

function accountErasureConfig(coreApiUrl: URL | null): AuthConfig["accountErasure"] {
  const mode = process.env.ACCOUNT_ERASURE_MODE?.trim() || "off";
  if (mode === "off") return { mode };
  if (mode !== "enforce") throw new Error("ACCOUNT_ERASURE_MODE must be off or enforce.");
  if (process.env.ACCOUNT_ACCESS_GATE_MODE?.trim() !== "enforce") {
    throw new Error("Account erasure requires the account access gate in enforce mode.");
  }
  if (!coreApiUrl) throw new Error("Missing required server configuration: CORE_API_URL");
  return { mode, coreApiUrl };
}

export function getAuthConfig(): AuthConfig {
  const appUrlValue = required("APP_URL");
  const appUrl = httpsUrl("APP_URL");
  if (
    appUrl.username ||
    appUrl.password ||
    appUrl.pathname !== "/" ||
    appUrl.search ||
    appUrl.hash ||
    appUrlValue !== appUrl.origin
  ) {
    throw new Error("APP_URL must be a canonical credential-free HTTPS origin.");
  }

  const upstreamSessionMaxSeconds = integer(
    "OIDC_UPSTREAM_SESSION_MAX_SECONDS",
    60,
    30 * 24 * 60 * 60,
  );
  const trustedProxy = trustedProxyConfig();
  const trustedProxyRanges = trustedProxyRangesConfig();
  const sessionHmacKey = decodeKey("SESSION_SECRET");
  const tokenEncryptionKey = decodeKey("TOKEN_ENCRYPTION_KEY", 32);
  const clientId = required("OIDC_CLIENT_ID");
  if (clientId !== "account-center") {
    throw new Error("OIDC_CLIENT_ID must be the dedicated account-center client.");
  }

  const coreApiUrl = coreApiUrlConfig();

  return {
    appUrl,
    issuer: oidcIssuer(),
    clientId,
    clientSecret: required("OIDC_CLIENT_SECRET"),
    upstreamSessionMaxSeconds,
    trustedProxy,
    trustedProxyRanges,
    databaseUrl: required("DATABASE_URL"),
    sessionHmacKey,
    tokenEncryptionKey,
    oidcTransactionTtlSeconds: 5 * 60,
    sessionAbsoluteTtlSeconds: Math.min(8 * 60 * 60, upstreamSessionMaxSeconds),
    sessionIdleTtlSeconds: 30 * 60,
    sessionRotationSeconds: 15 * 60,
    previousHandleGraceSeconds: 30,
    coreApiUrl,
    accountErasure: accountErasureConfig(coreApiUrl),
    ytuIdpAlias: ytuIdpAliasConfig(),
  };
}

export function oidcRedirectUri(config: AuthConfig) {
  return new URL("/api/auth/callback", config.appUrl).href;
}
