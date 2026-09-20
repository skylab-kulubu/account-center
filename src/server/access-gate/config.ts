import "server-only";

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
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
      tlsCert?: string;
      tlsKey?: string;
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

function pemFile(name: string, kind: "certificate" | "private key") {
  const path = required(name);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path.`);

  let value: string;
  try {
    value = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${name} must point to a readable file.`);
  }
  const marker = kind === "certificate"
    ? /-----BEGIN CERTIFICATE-----/
    : /-----BEGIN (?:EC |RSA |ENCRYPTED )?PRIVATE KEY-----/;
  if (!marker.test(value)) throw new Error(`${name} must contain a PEM ${kind}.`);
  return value;
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
  const tlsCa = tls ? pemFile("ACCOUNT_ACCESS_REDIS_CA_CERT_FILE", "certificate") : undefined;
  const tlsCert = tls ? pemFile("ACCOUNT_ACCESS_REDIS_TLS_CERT_FILE", "certificate") : undefined;
  const tlsKey = tls ? pemFile("ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE", "private key") : undefined;

  return {
    mode,
    host: required("ACCOUNT_ACCESS_REDIS_HOST"),
    port: integer("ACCOUNT_ACCESS_REDIS_PORT", 1, 65_535),
    username: required("ACCOUNT_ACCESS_REDIS_USERNAME"),
    password: required("ACCOUNT_ACCESS_REDIS_PASSWORD"),
    database: integer("ACCOUNT_ACCESS_REDIS_DATABASE", 0, 255),
    tls,
    ...(tlsServerName ? { tlsServerName } : {}),
    ...(tlsCa ? { tlsCa } : {}),
    ...(tlsCert ? { tlsCert } : {}),
    ...(tlsKey ? { tlsKey } : {}),
    operationTimeoutMs: integer("ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS", 50, 1_000),
  };
}
