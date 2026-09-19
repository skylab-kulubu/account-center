const required = [
  "APP_URL",
  "DATABASE_URL",
  "SESSION_SECRET",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
];

const forbiddenPublicSecrets = [
  "NEXT_PUBLIC_DATABASE_URL",
  "NEXT_PUBLIC_SESSION_SECRET",
  "NEXT_PUBLIC_OIDC_CLIENT_SECRET",
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
  const sensitive = ["DATABASE_URL", "SESSION_SECRET", "OIDC_CLIENT_SECRET"];
  const placeholder = sensitive.find((name) => placeholderPattern.test(values[name]));
  if (placeholder) throw new Error(`${placeholder} contains a placeholder value.`);

  if (!/^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(values.SESSION_SECRET)) {
    throw new Error("SESSION_SECRET must be at least 32 bytes encoded as base64 or base64url.");
  }

  if (values.OIDC_CLIENT_SECRET.length < 32) {
    throw new Error("OIDC_CLIENT_SECRET must contain at least 32 characters.");
  }

  requireHttpsUrl("APP_URL", values.APP_URL);
  requireHttpsUrl("OIDC_ISSUER", values.OIDC_ISSUER);
  requireDatabaseUrl(values.DATABASE_URL);
}
