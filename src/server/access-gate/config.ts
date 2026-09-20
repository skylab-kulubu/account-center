import "server-only";

import { ACCOUNT_ACCESS_ISSUER } from "@/server/access-gate/contract";

export type AccountAccessGateConfig =
  | { mode: "off" }
  | {
      mode: "enforce";
      host: string;
      port: number;
      username: string;
      password: string;
      database: number;
      tls: boolean;
      tlsServerName?: string;
      tlsCa?: string;
      operationTimeoutMs: number;
    };

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
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

function tlsCa() {
  const encoded = process.env.ACCOUNT_ACCESS_REDIS_TLS_CA_BASE64?.trim();
  if (!encoded) return undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    throw new Error("ACCOUNT_ACCESS_REDIS_TLS_CA_BASE64 must be base64 encoded.");
  }
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(
    `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`,
    "base64",
  );
  if (decoded.length === 0) {
    throw new Error("ACCOUNT_ACCESS_REDIS_TLS_CA_BASE64 must not be empty.");
  }
  return decoded.toString("utf8");
}

export function getAccountAccessGateConfig(issuer: URL): AccountAccessGateConfig {
  const mode = required("ACCOUNT_ACCESS_GATE_MODE");
  if (mode === "off") return { mode };
  if (mode !== "enforce") {
    throw new Error("ACCOUNT_ACCESS_GATE_MODE must be off or enforce.");
  }
  if (issuer.href !== ACCOUNT_ACCESS_ISSUER) {
    throw new Error("OIDC_ISSUER must match the account access v1 contract in enforce mode.");
  }

  const tlsValue = required("ACCOUNT_ACCESS_REDIS_TLS");
  if (tlsValue !== "true" && tlsValue !== "false") {
    throw new Error("ACCOUNT_ACCESS_REDIS_TLS must be true or false.");
  }
  const tls = tlsValue === "true";
  if (process.env.NODE_ENV === "production" && !tls) {
    throw new Error("ACCOUNT_ACCESS_REDIS_TLS must be true in production.");
  }
  const tlsServerName = tls ? required("ACCOUNT_ACCESS_REDIS_TLS_SERVER_NAME") : undefined;
  const ca = tlsCa();

  return {
    mode,
    host: required("ACCOUNT_ACCESS_REDIS_HOST"),
    port: integer("ACCOUNT_ACCESS_REDIS_PORT", 1, 65_535),
    username: required("ACCOUNT_ACCESS_REDIS_USERNAME"),
    password: required("ACCOUNT_ACCESS_REDIS_PASSWORD"),
    database: integer("ACCOUNT_ACCESS_REDIS_DATABASE", 0, 255),
    tls,
    ...(tlsServerName ? { tlsServerName } : {}),
    ...(ca ? { tlsCa: ca } : {}),
    operationTimeoutMs: integer("ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS", 50, 1_000),
  };
}
