import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

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
  "ACCOUNT_ACCESS_GATE_MODE",
];

const forbiddenPublicSecrets = [
  "NEXT_PUBLIC_DATABASE_URL",
  "NEXT_PUBLIC_SESSION_SECRET",
  "NEXT_PUBLIC_TOKEN_ENCRYPTION_KEY",
  "NEXT_PUBLIC_OIDC_CLIENT_SECRET",
  "NEXT_PUBLIC_ACCOUNT_ACCESS_REDIS_PASSWORD",
  "NEXT_PUBLIC_ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE",
  "NEXT_PUBLIC_CORE_API_URL",
];

const placeholderPattern = /(?:change[-_ ]?me|replace[-_ ]?with|example|placeholder|<[^>]+>)/i;

/** Mirrors AUTH_TRUSTED_PROXY_MODES in src/server/auth/trusted-proxy.ts. */
const trustedProxyModes = ["cloudflare", "traefik", "none"];
/** Mirrors DEFAULT_TRUSTED_PROXY_RANGES in src/server/auth/trusted-proxy.ts. */
const defaultTrustedProxyRanges = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7";

function ipv4Bytes(value) {
  return Uint8Array.from(value.split(".").map(Number));
}

function ipv6Bytes(value) {
  let text = value;
  const embeddedIpv4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (embeddedIpv4) {
    const quads = ipv4Bytes(embeddedIpv4[1]);
    text = `${text.slice(0, embeddedIpv4.index)}${((quads[0] << 8) | quads[1]).toString(16)}:${((quads[2] << 8) | quads[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const headGroups = halves[0] ? halves[0].split(":") : [];
  const tailGroups = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [
    ...headGroups,
    ...(halves.length === 1 ? [] : Array.from({ length: missing }, () => "0")),
    ...tailGroups,
  ];
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    const word = Number.parseInt(group, 16);
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null;
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function ipBytes(value) {
  if (value.includes("%")) return null;
  const version = isIP(value);
  if (version === 4) return ipv4Bytes(value);
  if (version === 6) return ipv6Bytes(value);
  return null;
}

/** A CIDR block whose host bits are all zero, so nothing wider than written is trusted. */
function isCanonicalCidr(entry) {
  const separator = entry.indexOf("/");
  if (separator < 0) return false;
  const bytes = ipBytes(entry.slice(0, separator));
  const prefix = entry.slice(separator + 1);
  if (!bytes || !/^(?:0|[1-9]\d{0,2})$/.test(prefix)) return false;
  const prefixLength = Number(prefix);
  if (prefixLength > bytes.length * 8) return false;
  return bytes.every((byte, index) => {
    const significant = Math.min(8, Math.max(0, prefixLength - index * 8));
    return byte === (significant === 0 ? 0 : byte & ((0xff << (8 - significant)) & 0xff));
  });
}

function validateTrustedProxyEnvironment(env, mode) {
  if (!trustedProxyModes.includes(mode)) {
    throw new Error("AUTH_TRUSTED_PROXY must be cloudflare, traefik or none.");
  }
  const value = env.AUTH_TRUSTED_PROXY_RANGES?.trim() || defaultTrustedProxyRanges;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || !entries.every(isCanonicalCidr)) {
    throw new Error(
      "AUTH_TRUSTED_PROXY_RANGES must be a comma-separated list of canonical CIDR blocks.",
    );
  }
}

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

function requireInteger(name, value, minimum, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the safe range.`);
  }
}

function requirePemFile(name, value, kind) {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  let contents;
  try {
    contents = readFileSync(value, "utf8");
  } catch {
    throw new Error(`${name} must point to a readable file.`);
  }
  const marker = kind === "certificate"
    ? /-----BEGIN CERTIFICATE-----/
    : /-----BEGIN (?:EC |RSA |ENCRYPTED )?PRIVATE KEY-----/;
  if (!marker.test(contents)) throw new Error(`${name} must contain a PEM ${kind}.`);
}

function validateAccountAccessEnvironment(env, issuer) {
  const mode = env.ACCOUNT_ACCESS_GATE_MODE?.trim();
  if (mode !== "off" && mode !== "enforce") {
    throw new Error("ACCOUNT_ACCESS_GATE_MODE must be off or enforce.");
  }
  if (mode === "off") return;
  if (issuer !== "https://e.yildizskylab.com/realms/e-skylab") {
    throw new Error("OIDC_ISSUER must match the account access v1 contract in enforce mode.");
  }
  const names = [
    "ACCOUNT_ACCESS_REDIS_HOST",
    "ACCOUNT_ACCESS_REDIS_PORT",
    "ACCOUNT_ACCESS_REDIS_USERNAME",
    "ACCOUNT_ACCESS_REDIS_PASSWORD",
    "ACCOUNT_ACCESS_REDIS_DATABASE",
    "ACCOUNT_ACCESS_REDIS_TLS",
    "ACCOUNT_ACCESS_REDIS_TLS_SERVER_NAME",
    "ACCOUNT_ACCESS_REDIS_CA_CERT_FILE",
    "ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE",
    "ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE",
    "ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS",
  ];
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  const placeholder = names.find((name) => placeholderPattern.test(env[name]));
  if (placeholder) throw new Error(`${placeholder} contains a placeholder value.`);
  if (env.ACCOUNT_ACCESS_REDIS_TLS.trim() !== "true") {
    throw new Error("ACCOUNT_ACCESS_REDIS_TLS must be true in production.");
  }
  requireInteger("ACCOUNT_ACCESS_REDIS_PORT", env.ACCOUNT_ACCESS_REDIS_PORT.trim(), 1, 65_535);
  requireInteger("ACCOUNT_ACCESS_REDIS_DATABASE", env.ACCOUNT_ACCESS_REDIS_DATABASE.trim(), 0, 255);
  requireInteger(
    "ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS",
    env.ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS.trim(),
    50,
    1_000,
  );
  requirePemFile(
    "ACCOUNT_ACCESS_REDIS_CA_CERT_FILE",
    env.ACCOUNT_ACCESS_REDIS_CA_CERT_FILE.trim(),
    "certificate",
  );
  requirePemFile(
    "ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE",
    env.ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE.trim(),
    "certificate",
  );
  requirePemFile(
    "ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE",
    env.ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE.trim(),
    "private key",
  );
}

function validateCoreApiEnvironment(env) {
  const value = env.CORE_API_URL?.trim();
  if (!value) return;
  if (placeholderPattern.test(value)) throw new Error("CORE_API_URL contains a placeholder value.");
  requireHttpsOrigin("CORE_API_URL", value);
}

function validateProfilePictureOriginEnvironment(env) {
  const value = env.PROFILE_PICTURE_ORIGIN?.trim();
  if (!value) return;
  if (placeholderPattern.test(value)) throw new Error("PROFILE_PICTURE_ORIGIN contains a placeholder value.");
  requireHttpsOrigin("PROFILE_PICTURE_ORIGIN", value);
}

function validateYtuIdpAliasEnvironment(env) {
  const value = env.YTU_IDP_ALIAS?.trim();
  if (!value) return;
  if (placeholderPattern.test(value)) throw new Error("YTU_IDP_ALIAS contains a placeholder value.");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error("YTU_IDP_ALIAS must be a Keycloak identity provider alias of 1-64 URL-safe characters.");
  }
}

function validateAccountErasureEnvironment(env) {
  const mode = env.ACCOUNT_ERASURE_MODE?.trim() || "off";
  if (mode !== "off" && mode !== "enforce") {
    throw new Error("ACCOUNT_ERASURE_MODE must be off or enforce.");
  }
  if (mode === "off") return;
  if (env.ACCOUNT_ACCESS_GATE_MODE?.trim() !== "enforce") {
    throw new Error("Account erasure requires the account access gate in enforce mode.");
  }
  if (!env.CORE_API_URL?.trim()) throw new Error("Missing required environment variables: CORE_API_URL");
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
  const sensitive = ["DATABASE_URL", "SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "OIDC_CLIENT_SECRET"];
  const placeholder = sensitive.find((name) => placeholderPattern.test(values[name]));
  if (placeholder) throw new Error(`${placeholder} contains a placeholder value.`);

  decodeBase64Secret("SESSION_SECRET", values.SESSION_SECRET, 32);
  const encryptionKey = decodeBase64Secret("TOKEN_ENCRYPTION_KEY", values.TOKEN_ENCRYPTION_KEY, 32);
  if (encryptionKey.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");

  if (values.OIDC_CLIENT_SECRET.length < 32) {
    throw new Error("OIDC_CLIENT_SECRET must contain at least 32 characters.");
  }
  if (values.OIDC_CLIENT_ID !== "account-center") {
    throw new Error("OIDC_CLIENT_ID must be the dedicated account-center client.");
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
  validateTrustedProxyEnvironment(env, values.AUTH_TRUSTED_PROXY);

  requireHttpsOrigin("APP_URL", values.APP_URL);
  requireOidcIssuer(values.OIDC_ISSUER);
  validateAccountAccessEnvironment(env, values.OIDC_ISSUER);
  validateCoreApiEnvironment(env);
  validateProfilePictureOriginEnvironment(env);
  validateYtuIdpAliasEnvironment(env);
  validateAccountErasureEnvironment(env);
  validateDatabaseEnvironment(env);
}
