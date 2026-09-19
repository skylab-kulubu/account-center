const required = [
  "APP_URL",
  "DATABASE_URL",
  "SESSION_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_UPSTREAM_SESSION_MAX_SECONDS",
  "AUTH_TRUSTED_PROXY",
  "NATIVE_BRIDGE_HMAC_SECRET",
  "NATIVE_BRIDGE_MTLS_CLIENT_SHA256",
];

const forbiddenPublicSecrets = [
  "NEXT_PUBLIC_DATABASE_URL",
  "NEXT_PUBLIC_SESSION_SECRET",
  "NEXT_PUBLIC_TOKEN_ENCRYPTION_KEY",
  "NEXT_PUBLIC_OIDC_CLIENT_SECRET",
  "NEXT_PUBLIC_NATIVE_BRIDGE_HMAC_SECRET",
];

const placeholderPattern = /(?:change[-_ ]?me|replace[-_ ]?with|example|placeholder|<[^>]+>)/i;

function requireHttpsUrl(name, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("HTTPS is required");
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
}

function requireHttpsOrigin(name, value) {
  requireHttpsUrl(name, value);
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin
  ) {
    throw new Error(`${name} must be a canonical credential-free HTTPS origin.`);
  }
}

function requireOidcIssuer(value) {
  requireHttpsUrl("OIDC_ISSUER", value);
  const url = new URL(value);
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
}

function requireDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password) {
    throw new Error("DATABASE_URL must be an authenticated PostgreSQL URL.");
  }
}

function decodeBase64Secret(name, value, expectedBytes) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new Error(`${name} must be base64 or base64url encoded.`);
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(`${normalized}${padding}`, "base64");

  if (decoded.length < expectedBytes) {
    throw new Error(`${name} must decode to at least ${expectedBytes} bytes.`);
  }

  return decoded;
}

export function validateDatabaseEnvironment(env) {
  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error("Missing required environment variables: DATABASE_URL");
  if (placeholderPattern.test(value)) throw new Error("DATABASE_URL contains a placeholder value.");
  requireDatabaseUrl(value);
}

export function validateEnvironment(env) {
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const exposed = forbiddenPublicSecrets.filter((name) => env[name]?.trim());
  if (exposed.length > 0) {
    throw new Error(`Secrets must not use NEXT_PUBLIC_: ${exposed.join(", ")}`);
  }

  const values = Object.fromEntries(required.map((name) => [name, env[name].trim()]));
  const sensitive = ["DATABASE_URL", "SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "OIDC_CLIENT_SECRET", "NATIVE_BRIDGE_HMAC_SECRET"];
  const placeholder = sensitive.find((name) => placeholderPattern.test(values[name]));
  if (placeholder) throw new Error(`${placeholder} contains a placeholder value.`);

  const sessionSecret = decodeBase64Secret("SESSION_SECRET", values.SESSION_SECRET, 32);
  const encryptionKey = decodeBase64Secret("TOKEN_ENCRYPTION_KEY", values.TOKEN_ENCRYPTION_KEY, 32);
  if (encryptionKey.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  const nativeBridgeHmacSecret = decodeBase64Secret(
    "NATIVE_BRIDGE_HMAC_SECRET",
    values.NATIVE_BRIDGE_HMAC_SECRET,
    32,
  );
  if (
    nativeBridgeHmacSecret.equals(sessionSecret) ||
    nativeBridgeHmacSecret.equals(encryptionKey)
  ) {
    throw new Error("NATIVE_BRIDGE_HMAC_SECRET must differ from other server keys.");
  }
  if (!/^[a-f0-9]{64}$/.test(values.NATIVE_BRIDGE_MTLS_CLIENT_SHA256)) {
    throw new Error("NATIVE_BRIDGE_MTLS_CLIENT_SHA256 must be a lowercase SHA-256 fingerprint.");
  }

  if (values.OIDC_CLIENT_SECRET.length < 32) {
    throw new Error("OIDC_CLIENT_SECRET must contain at least 32 characters.");
  }

  if (!/^\d+$/.test(values.OIDC_UPSTREAM_SESSION_MAX_SECONDS)) {
    throw new Error("OIDC_UPSTREAM_SESSION_MAX_SECONDS must be an integer.");
  }
  const upstreamSessionMax = Number(values.OIDC_UPSTREAM_SESSION_MAX_SECONDS);
  if (
    !Number.isSafeInteger(upstreamSessionMax) ||
    upstreamSessionMax < 60 ||
    upstreamSessionMax > 30 * 24 * 60 * 60
  ) {
    throw new Error("OIDC_UPSTREAM_SESSION_MAX_SECONDS is outside the safe range.");
  }
  if (values.AUTH_TRUSTED_PROXY !== "cloudflare") {
    throw new Error("AUTH_TRUSTED_PROXY must be cloudflare.");
  }

  requireHttpsOrigin("APP_URL", values.APP_URL);
  requireOidcIssuer(values.OIDC_ISSUER);
  validateDatabaseEnvironment(env);
}
