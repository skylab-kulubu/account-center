import "server-only";

import { decodeJwt, decodeProtectedHeader } from "jose";
import { isReservedObjectKey } from "@/server/contract-shapes";

const requiredAccountRoles = ["manage-account", "view-profile"] as const;

/**
 * Exact audience set of an Account Center user token after the K2 realm
 * reconcile: the `account-center-account-api` scope adds the `core` audience
 * (for the person's own core `/v1/users/me` endpoints) without any core roles.
 * Pre-cutover tokens carry only `account` and are rejected on purpose.
 */
const requiredAudiences = ["account", "core"] as const;

const MAX_AUTHORIZATION_CLIENTS = 64;
const MAX_AUTHORIZATION_ROLES_PER_CLIENT = 256;
const MAX_AUTHORIZATION_NAME_LENGTH = 255;
const clientIdShape = /^[^\p{Cc}\p{Cf}\p{Z}]+$/u;
const roleNameShape = /^[^\p{Cc}\p{Cf}\p{Z}](?:[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*[^\p{Cc}\p{Cf}\p{Z}])?$/u;

/**
 * Flat read model of the `sky_authorization` claim: client ID → client roles
 * the person holds. The claim is emitted by the K2 client-role mapper as
 * `sky_authorization.${client_id}.roles` and is informational only; it never
 * grants anything inside Account Center and is rendered by the Permissions view.
 */
export type SkyAuthorization = Readonly<Record<string, readonly string[]>>;

export type ValidatedAccountAccessToken = {
  expiresAt: Date;
  authorization: SkyAuthorization;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredAccountRoles(resourceAccess: unknown) {
  if (!isRecord(resourceAccess)) return false;
  const account = resourceAccess.account;
  if (!isRecord(account)) return false;
  const roles = account.roles;
  return Array.isArray(roles) && requiredAccountRoles.every((role) => roles.includes(role));
}

function carriesCoreResourceAccess(resourceAccess: unknown) {
  return isRecord(resourceAccess) && Object.hasOwn(resourceAccess, "core");
}

function hasExactAudienceSet(audience: unknown) {
  const values = typeof audience === "string" ? [audience] : audience;
  if (!Array.isArray(values) || values.length !== requiredAudiences.length) return false;
  const unique = new Set(values);
  return unique.size === requiredAudiences.length &&
    requiredAudiences.every((required) => unique.has(required));
}

function validAuthorizationName(value: unknown, shape: RegExp): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AUTHORIZATION_NAME_LENGTH &&
    !isReservedObjectKey(value) &&
    shape.test(value);
}

function parseSkyAuthorization(claim: unknown): SkyAuthorization | null {
  if (claim === undefined || claim === null) return Object.freeze(Object.create(null) as Record<string, never>);
  if (!isRecord(claim)) return null;
  const entries = Object.entries(claim);
  if (entries.length > MAX_AUTHORIZATION_CLIENTS) return null;
  const authorization: Record<string, readonly string[]> = Object.create(null);
  for (const [clientId, access] of entries) {
    if (!validAuthorizationName(clientId, clientIdShape) || !isRecord(access)) return null;
    const keys = Object.keys(access);
    if (keys.length !== 1 || keys[0] !== "roles" || !Array.isArray(access.roles)) return null;
    if (access.roles.length > MAX_AUTHORIZATION_ROLES_PER_CLIENT) return null;
    const roles = new Set<string>();
    for (const role of access.roles) {
      if (!validAuthorizationName(role, roleNameShape) || roles.has(role)) return null;
      roles.add(role);
    }
    authorization[clientId] = Object.freeze([...roles]);
  }
  return Object.freeze(authorization);
}

export class AccountAccessTokenContractError extends Error {
  constructor() {
    super("The server-held Account REST token does not match the pinned user-token contract.");
    this.name = "AccountAccessTokenContractError";
  }
}

export class AccountAccessTokenExpiredError extends Error {
  constructor() {
    super("The server-held Account REST token has expired.");
    this.name = "AccountAccessTokenExpiredError";
  }
}

export function validateAccountAccessToken(
  accessToken: string,
  expected: { issuer: URL; clientId: string; subject: string },
  now = new Date(),
): ValidatedAccountAccessToken {
  let claims;
  let header;
  try {
    claims = decodeJwt(accessToken);
    header = decodeProtectedHeader(accessToken);
  } catch {
    throw new AccountAccessTokenContractError();
  }
  const authorization = parseSkyAuthorization(claims.sky_authorization);
  if (
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    claims.iss !== expected.issuer.href.replace(/\/$/, "") ||
    claims.sub !== expected.subject ||
    claims.azp !== expected.clientId ||
    claims.scope !== "openid" ||
    !hasExactAudienceSet(claims.aud) ||
    !hasRequiredAccountRoles(claims.resource_access) ||
    carriesCoreResourceAccess(claims.resource_access) ||
    authorization === null ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp)
  ) {
    throw new AccountAccessTokenContractError();
  }
  const expiresAt = new Date(claims.exp * 1_000);
  if (!Number.isFinite(expiresAt.getTime())) throw new AccountAccessTokenContractError();
  if (claims.exp <= Math.floor(now.getTime() / 1_000)) {
    throw new AccountAccessTokenExpiredError();
  }
  return { expiresAt, authorization };
}
