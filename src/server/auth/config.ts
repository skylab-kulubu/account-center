import "server-only";

export type AuthConfig = {
  appUrl: URL;
  issuer: URL;
  clientId: string;
  clientSecret: string;
  upstreamSessionMaxSeconds: number;
  trustedProxy: "cloudflare";
  databaseUrl: string;
  sessionHmacKey: Buffer;
  tokenEncryptionKey: Buffer;
  oidcTransactionTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  sessionRotationSeconds: number;
  previousHandleGraceSeconds: number;
};

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
  const trustedProxy = required("AUTH_TRUSTED_PROXY");
  if (trustedProxy !== "cloudflare") {
    throw new Error("AUTH_TRUSTED_PROXY must be cloudflare.");
  }

  return {
    appUrl,
    issuer: oidcIssuer(),
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"),
    upstreamSessionMaxSeconds,
    trustedProxy,
    databaseUrl: required("DATABASE_URL"),
    sessionHmacKey: decodeKey("SESSION_SECRET"),
    tokenEncryptionKey: decodeKey("TOKEN_ENCRYPTION_KEY", 32),
    oidcTransactionTtlSeconds: 5 * 60,
    sessionAbsoluteTtlSeconds: Math.min(8 * 60 * 60, upstreamSessionMaxSeconds),
    sessionIdleTtlSeconds: 30 * 60,
    sessionRotationSeconds: 15 * 60,
    previousHandleGraceSeconds: 30,
  };
}

export function oidcRedirectUri(config: AuthConfig) {
  return new URL("/api/auth/callback", config.appUrl).href;
}
