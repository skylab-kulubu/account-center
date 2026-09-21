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
  nativeBridgeHmacSecret: Buffer;
  nativeBridgeMtlsClientSha256: string;
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
  const trustedProxy = required("AUTH_TRUSTED_PROXY");
  if (trustedProxy !== "cloudflare") {
    throw new Error("AUTH_TRUSTED_PROXY must be cloudflare.");
  }
  const nativeBridgeMtlsClientSha256 = required("NATIVE_BRIDGE_MTLS_CLIENT_SHA256");
  if (!/^[a-f0-9]{64}$/.test(nativeBridgeMtlsClientSha256)) {
    throw new Error("NATIVE_BRIDGE_MTLS_CLIENT_SHA256 must be a lowercase SHA-256 fingerprint.");
  }
  const sessionHmacKey = decodeKey("SESSION_SECRET");
  const tokenEncryptionKey = decodeKey("TOKEN_ENCRYPTION_KEY", 32);
  const nativeBridgeHmacSecret = decodeKey("NATIVE_BRIDGE_HMAC_SECRET");
  if (
    nativeBridgeHmacSecret.equals(sessionHmacKey) ||
    nativeBridgeHmacSecret.equals(tokenEncryptionKey)
  ) {
    throw new Error("NATIVE_BRIDGE_HMAC_SECRET must differ from other server keys.");
  }
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
    databaseUrl: required("DATABASE_URL"),
    sessionHmacKey,
    tokenEncryptionKey,
    nativeBridgeHmacSecret,
    nativeBridgeMtlsClientSha256,
    oidcTransactionTtlSeconds: 5 * 60,
    sessionAbsoluteTtlSeconds: Math.min(8 * 60 * 60, upstreamSessionMaxSeconds),
    sessionIdleTtlSeconds: 30 * 60,
    sessionRotationSeconds: 15 * 60,
    previousHandleGraceSeconds: 30,
    coreApiUrl,
    accountErasure: accountErasureConfig(coreApiUrl),
  };
}

export function oidcRedirectUri(config: AuthConfig) {
  return new URL("/api/auth/callback", config.appUrl).href;
}
