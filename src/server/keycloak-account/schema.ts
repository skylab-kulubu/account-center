import "server-only";

import { isReservedObjectKey } from "@/server/contract-shapes";
import type {
  AccountGroup,
  AccountProfile,
  AccountSession,
  AuthenticationSummary,
  CredentialInventory,
  JsonValue,
  LinkedAccount,
  OwnedCredential,
  ProfileAttributeMetadata,
  ProfileAttributeName,
  ProfileAttributes,
} from "@/server/keycloak-account/types";

export type KeycloakAccountResource =
  | "profile"
  | "credentials"
  | "sessions"
  | "devices"
  | "groups"
  | "linked-accounts"
  | "linked-account-uri";

export class KeycloakAccountContractError extends Error {
  constructor(readonly resource: KeycloakAccountResource) {
    super(`Keycloak 26.7.4 ${resource} response did not match the pinned contract.`);
    this.name = "KeycloakAccountContractError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function optionalString(value: unknown, maximum = 512): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && value.length <= maximum);
}

function requiredString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function optionalInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function stringListMap(value: unknown, maximumEntries = 256): value is Record<string, string[]> {
  return isObject(value) &&
    Object.keys(value).length <= maximumEntries &&
    Object.entries(value).every(([key, values]) =>
      key.length > 0 &&
      key.length <= 255 &&
      !isReservedObjectKey(key) &&
      Array.isArray(values) &&
      values.length <= 64 &&
      values.every((item) => typeof item === "string" && item.length <= 512),
    );
}

function copyStringListMap(value: Record<string, string[]>) {
  const copy: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(value)) copy[key] = [...values];
  return copy;
}

const MAX_JSON_DEPTH = 6;
const MAX_JSON_CONTAINER_SIZE = 64;

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 2_048;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_JSON_CONTAINER_SIZE && value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_JSON_CONTAINER_SIZE && entries.every(([key, item]) =>
    key.length <= 255 && !isReservedObjectKey(key) && isJsonValue(item, depth + 1),
  );
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isObject(value) && isJsonValue(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function optionalBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === "boolean";
}

function epochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asIsoDate(value: number) {
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) throw new KeycloakAccountContractError("sessions");
  return date.toISOString();
}

const profileKeys = new Set([
  "id",
  "username",
  "firstName",
  "lastName",
  "email",
  "emailVerified",
  "attributes",
  "userProfileMetadata",
  "enabled",
]);
const profileMetadataKeys = new Set(["attributes", "groups"]);
const attributeMetadataKeys = new Set([
  "name",
  "displayName",
  "required",
  "readOnly",
  "annotations",
  "validators",
  "group",
  "multivalued",
  "defaultValue",
]);
const attributeGroupMetadataKeys = new Set([
  "name",
  "displayHeader",
  "displayDescription",
  "annotations",
]);
const pinnedProfileAttributes: readonly ProfileAttributeName[] = [
  "schoolEmail",
  "personalEmail",
  "skyNumber",
  "department",
  "university",
];
const MAX_PROFILE_ATTRIBUTE_METADATA = 64;

function validAttributeGroupMetadata(value: unknown) {
  return isObject(value) &&
    hasOnlyKeys(value, attributeGroupMetadataKeys) &&
    requiredString(value.name, 255) &&
    optionalString(value.displayHeader) &&
    optionalString(value.displayDescription) &&
    (value.annotations === undefined || value.annotations === null || isJsonObject(value.annotations));
}

function parseAttributeMetadata(value: unknown): ProfileAttributeMetadata {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, attributeMetadataKeys) ||
    !requiredString(value.name, 255) ||
    !optionalString(value.displayName) ||
    typeof value.required !== "boolean" ||
    typeof value.readOnly !== "boolean" ||
    !optionalString(value.group, 255) ||
    !optionalBoolean(value.multivalued) ||
    !optionalString(value.defaultValue, 2_048) ||
    (value.annotations !== undefined && value.annotations !== null && !isJsonObject(value.annotations)) ||
    (value.validators !== undefined && value.validators !== null && !isJsonObject(value.validators))
  ) {
    throw new KeycloakAccountContractError("profile");
  }
  const validators: Record<string, Record<string, JsonValue>> = {};
  for (const [validatorId, config] of Object.entries(value.validators ?? {})) {
    if (!isJsonObject(config)) throw new KeycloakAccountContractError("profile");
    validators[validatorId] = cloneJson(config);
  }
  return {
    name: value.name,
    displayName: value.displayName?.trim() || null,
    required: value.required,
    readOnly: value.readOnly,
    validators,
    annotations: value.annotations ? cloneJson(value.annotations) : {},
  };
}

function parseProfileMetadata(value: unknown): ProfileAttributeMetadata[] {
  if (value === undefined || value === null) return [];
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, profileMetadataKeys) ||
    (value.attributes !== undefined && value.attributes !== null && !Array.isArray(value.attributes)) ||
    (value.groups !== undefined && value.groups !== null &&
      (!Array.isArray(value.groups) || value.groups.length > MAX_PROFILE_ATTRIBUTE_METADATA ||
        !value.groups.every(validAttributeGroupMetadata)))
  ) {
    throw new KeycloakAccountContractError("profile");
  }
  const attributes = value.attributes ?? [];
  if (attributes.length > MAX_PROFILE_ATTRIBUTE_METADATA) throw new KeycloakAccountContractError("profile");
  const seen = new Set<string>();
  return attributes.map((attribute) => {
    const parsed = parseAttributeMetadata(attribute);
    if (seen.has(parsed.name)) throw new KeycloakAccountContractError("profile");
    seen.add(parsed.name);
    return parsed;
  });
}

function pinnedAttributes(value: Record<string, string[]> | null | undefined): ProfileAttributes {
  const attributes = {} as ProfileAttributes;
  for (const name of pinnedProfileAttributes) {
    const first = value?.[name]?.[0];
    attributes[name] = first?.trim() || null;
  }
  return attributes;
}

export function parseProfile(value: unknown): AccountProfile {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, profileKeys) ||
    !optionalString(value.id) ||
    !optionalString(value.username) ||
    !optionalString(value.firstName) ||
    !optionalString(value.lastName) ||
    !optionalString(value.email) ||
    typeof value.emailVerified !== "boolean" ||
    !optionalBoolean(value.enabled) ||
    (value.attributes !== undefined && value.attributes !== null && !stringListMap(value.attributes))
  ) {
    throw new KeycloakAccountContractError("profile");
  }
  return {
    username: value.username?.trim() || null,
    firstName: value.firstName?.trim() || null,
    lastName: value.lastName?.trim() || null,
    email: value.email?.trim() || null,
    emailVerified: value.emailVerified,
    attributes: pinnedAttributes(value.attributes),
    attributeMetadata: parseProfileMetadata(value.userProfileMetadata),
  };
}

const credentialContainerKeys = new Set([
  "type",
  "category",
  "displayName",
  "helptext",
  "iconCssClass",
  "createAction",
  "updateAction",
  "removeable",
  "userCredentialMetadatas",
]);
const credentialMetadataKeys = new Set([
  "infoMessage",
  "infoProperties",
  "warningMessageTitle",
  "warningMessageDescription",
  "credential",
  "iconLight",
  "iconDark",
]);
const localizedMessageKeys = new Set(["key", "parameters"]);
const credentialKeys = new Set([
  "id",
  "type",
  "userLabel",
  "createdDate",
  "secretData",
  "credentialData",
  "priority",
  "value",
  "temporary",
  "device",
  "hashedSaltedValue",
  "salt",
  "hashIterations",
  "counter",
  "algorithm",
  "digits",
  "period",
  "config",
  "federationLink",
]);

function validLocalizedMessage(value: unknown) {
  if (value === undefined || value === null) return true;
  if (!isObject(value) || !hasOnlyKeys(value, localizedMessageKeys) || !requiredString(value.key)) return false;
  return value.parameters === undefined || (
    Array.isArray(value.parameters) && value.parameters.every((parameter) => typeof parameter === "string")
  );
}

function validCredential(value: unknown) {
  if (!isObject(value) || !hasOnlyKeys(value, credentialKeys) || !requiredString(value.type)) return false;
  if (!optionalString(value.id) || !optionalString(value.userLabel)) return false;
  if (
    value.createdDate !== undefined &&
    value.createdDate !== null &&
    (typeof value.createdDate !== "number" || !Number.isSafeInteger(value.createdDate) || value.createdDate < 0)
  ) return false;
  if (value.secretData !== undefined && value.secretData !== null) return false;
  if (!optionalString(value.credentialData, 32_768) || !optionalString(value.federationLink)) return false;
  if (!optionalInteger(value.priority) || !optionalString(value.value, 32_768) || !optionalBoolean(value.temporary)) return false;
  if (!optionalString(value.device) || !optionalString(value.hashedSaltedValue, 32_768) || !optionalString(value.salt, 32_768)) return false;
  if (!optionalInteger(value.hashIterations) || !optionalInteger(value.counter)) return false;
  if (!optionalString(value.algorithm) || !optionalInteger(value.digits) || !optionalInteger(value.period)) return false;
  return value.config === undefined || value.config === null || stringListMap(value.config);
}

function validCredentialMetadata(value: unknown) {
  if (!isObject(value) || !hasOnlyKeys(value, credentialMetadataKeys) || !validCredential(value.credential)) return false;
  if (!validLocalizedMessage(value.infoMessage) || !validLocalizedMessage(value.warningMessageTitle)) return false;
  if (!validLocalizedMessage(value.warningMessageDescription)) return false;
  if (
    value.infoProperties !== undefined && value.infoProperties !== null &&
    (!Array.isArray(value.infoProperties) || !value.infoProperties.every(validLocalizedMessage))
  ) return false;
  return optionalString(value.iconLight) && optionalString(value.iconDark);
}

export function parseCredentialInventory(value: unknown): CredentialInventory {
  if (!Array.isArray(value) || value.length > 32) throw new KeycloakAccountContractError("credentials");
  const counts = new Map<string, number>();
  const credentials: OwnedCredential[] = [];
  const seenCredentialIds = new Set<string>();
  for (const container of value) {
    if (
      !isObject(container) ||
      !hasOnlyKeys(container, credentialContainerKeys) ||
      !requiredString(container.type, 128) ||
      !optionalString(container.category) ||
      !optionalString(container.displayName) ||
      !optionalString(container.helptext) ||
      !optionalString(container.iconCssClass) ||
      !optionalString(container.createAction) ||
      !optionalString(container.updateAction) ||
      typeof container.removeable !== "boolean" ||
      (container.userCredentialMetadatas !== null &&
        (!Array.isArray(container.userCredentialMetadatas) ||
          !container.userCredentialMetadatas.every(validCredentialMetadata)))
    ) {
      throw new KeycloakAccountContractError("credentials");
    }
    const metadatas = container.userCredentialMetadatas ?? [];
    if (credentials.length + metadatas.length > 64) {
      throw new KeycloakAccountContractError("credentials");
    }
    counts.set(container.type, (counts.get(container.type) ?? 0) + metadatas.length);
    for (const metadata of metadatas) {
      const credential = metadata.credential;
      if (!credential.id) continue;
      if (seenCredentialIds.has(credential.id)) {
        throw new KeycloakAccountContractError("credentials");
      }
      seenCredentialIds.add(credential.id);
      let createdAt: string | null = null;
      if (credential.createdDate !== undefined && credential.createdDate !== null) {
        const parsed = new Date(credential.createdDate);
        if (!Number.isFinite(parsed.getTime())) {
          throw new KeycloakAccountContractError("credentials");
        }
        createdAt = parsed.toISOString();
      }
      credentials.push({
        id: credential.id,
        type: credential.type,
        label: credential.userLabel?.trim() || null,
        createdAt,
        removeable: container.removeable,
      });
    }
  }
  return {
    summary: {
      passwordConfigured: (counts.get("password") ?? 0) > 0,
      otpConfigured: (counts.get("otp") ?? 0) + (counts.get("totp") ?? 0) > 0,
      passkeyCount: (counts.get("webauthn") ?? 0) + (counts.get("webauthn-passwordless") ?? 0),
    },
    credentials,
  };
}

export function parseAuthenticationSummary(value: unknown): AuthenticationSummary {
  return parseCredentialInventory(value).summary;
}

const sessionKeys = new Set([
  "id",
  "ipAddress",
  "started",
  "lastAccess",
  "expires",
  "clients",
  "browser",
  "current",
]);
const deviceKeys = new Set([
  "id",
  "ipAddress",
  "os",
  "osVersion",
  "browser",
  "device",
  "lastAccess",
  "current",
  "sessions",
  "mobile",
]);
const clientKeys = new Set([
  "clientId",
  "clientName",
  "description",
  "userConsentRequired",
  "inUse",
  "offlineAccess",
  "rootUrl",
  "baseUrl",
  "effectiveUrl",
  "consent",
  "logoUri",
  "policyUri",
  "tosUri",
]);

function validSessionClient(value: unknown) {
  if (!isObject(value) || !hasOnlyKeys(value, clientKeys) || !requiredString(value.clientId)) return false;
  for (const key of [
    "clientName",
    "description",
    "rootUrl",
    "baseUrl",
    "effectiveUrl",
    "logoUri",
    "policyUri",
    "tosUri",
  ]) {
    if (!optionalString(value[key])) return false;
  }
  for (const key of ["userConsentRequired", "inUse", "offlineAccess"]) {
    if (!optionalBoolean(value[key])) return false;
  }
  return value.consent === undefined || value.consent === null || isObject(value.consent);
}

type ParsedSession = {
  id: string;
  started: number;
  lastAccess: number;
  expires: number;
  browser: string | null;
  current: boolean;
};

function parseSession(value: unknown, resource: "sessions" | "devices"): ParsedSession {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, sessionKeys) ||
    !requiredString(value.id) ||
    !optionalString(value.ipAddress) ||
    !epochSeconds(value.started) ||
    !epochSeconds(value.lastAccess) ||
    !epochSeconds(value.expires) ||
    (!Array.isArray(value.clients) || !value.clients.every(validSessionClient)) ||
    !optionalString(value.browser) ||
    !optionalBoolean(value.current)
  ) {
    throw new KeycloakAccountContractError(resource);
  }
  return {
    id: value.id,
    started: value.started,
    lastAccess: value.lastAccess,
    expires: value.expires,
    browser: value.browser ?? null,
    current: value.current === true,
  };
}

type DeviceHint = NonNullable<AccountSession["device"]>;

export function parseDeviceHints(value: unknown): Map<string, DeviceHint> {
  if (!Array.isArray(value)) throw new KeycloakAccountContractError("devices");
  const hints = new Map<string, DeviceHint>();
  for (const device of value) {
    if (
      !isObject(device) ||
      !hasOnlyKeys(device, deviceKeys) ||
      !optionalString(device.id) ||
      !optionalString(device.ipAddress) ||
      !optionalString(device.os) ||
      !optionalString(device.osVersion) ||
      !optionalString(device.browser) ||
      !optionalString(device.device) ||
      !epochSeconds(device.lastAccess) ||
      !optionalBoolean(device.current) ||
      !Array.isArray(device.sessions) ||
      typeof device.mobile !== "boolean"
    ) {
      throw new KeycloakAccountContractError("devices");
    }
    const hint: DeviceHint = {
      name: device.device?.trim() || null,
      operatingSystem: device.os?.trim() || null,
      operatingSystemVersion: device.osVersion?.trim() || null,
      mobile: device.mobile,
    };
    for (const session of device.sessions) {
      const parsed = parseSession(session, "devices");
      if (hints.has(parsed.id)) throw new KeycloakAccountContractError("devices");
      hints.set(parsed.id, hint);
    }
  }
  return hints;
}

export function parseSessions(value: unknown, deviceHints = new Map<string, DeviceHint>()): AccountSession[] {
  if (!Array.isArray(value)) throw new KeycloakAccountContractError("sessions");
  const seen = new Set<string>();
  let currentCount = 0;
  const sessions = value.map((session) => {
    const parsed = parseSession(session, "sessions");
    if (seen.has(parsed.id)) throw new KeycloakAccountContractError("sessions");
    seen.add(parsed.id);
    if (parsed.current) currentCount += 1;
    return {
      id: parsed.id,
      startedAt: asIsoDate(parsed.started),
      lastAccessAt: asIsoDate(parsed.lastAccess),
      expiresAt: asIsoDate(parsed.expires),
      browser: parsed.browser,
      current: parsed.current,
      device: deviceHints.get(parsed.id) ?? null,
    };
  });
  if (sessions.length > 0 && currentCount !== 1) {
    throw new KeycloakAccountContractError("sessions");
  }
  return sessions.sort((left, right) =>
    Number(right.current) - Number(left.current) ||
    right.lastAccessAt.localeCompare(left.lastAccessAt),
  );
}

const groupKeys = new Set([
  "id",
  "name",
  "description",
  "path",
  "parentId",
  "subGroupCount",
  "subGroups",
  "attributes",
  "realmRoles",
  "clientRoles",
  "access",
]);
const MAX_GROUPS = 256;
const groupPath = /^\/[^\p{Cc}]{1,1023}$/u;

export function parseGroups(value: unknown): AccountGroup[] {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) throw new KeycloakAccountContractError("groups");
  const seen = new Set<string>();
  return value.map((group) => {
    if (
      !isObject(group) ||
      !hasOnlyKeys(group, groupKeys) ||
      !requiredString(group.id, 255) ||
      !requiredString(group.name, 255) ||
      !optionalString(group.description, 2_048) ||
      !requiredString(group.path, 1_024) ||
      !groupPath.test(group.path) ||
      !optionalString(group.parentId) ||
      !optionalInteger(group.subGroupCount) ||
      (group.subGroups !== undefined && group.subGroups !== null && !Array.isArray(group.subGroups)) ||
      (group.attributes !== undefined && group.attributes !== null && !stringListMap(group.attributes)) ||
      (group.realmRoles !== undefined && group.realmRoles !== null &&
        (!Array.isArray(group.realmRoles) || !group.realmRoles.every((role) => typeof role === "string"))) ||
      (group.clientRoles !== undefined && group.clientRoles !== null && !stringListMap(group.clientRoles)) ||
      (group.access !== undefined && group.access !== null && !isObject(group.access))
    ) {
      throw new KeycloakAccountContractError("groups");
    }
    if (seen.has(group.id)) throw new KeycloakAccountContractError("groups");
    seen.add(group.id);
    return {
      id: group.id,
      name: group.name,
      path: group.path,
      attributes: group.attributes ? copyStringListMap(group.attributes) : {},
    };
  });
}

const linkedAccountKeys = new Set([
  "connected",
  "social",
  "providerAlias",
  "providerName",
  "displayName",
  "linkedUsername",
]);
const MAX_LINKED_ACCOUNTS = 64;
const providerAlias = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function parseLinkedAccounts(value: unknown): LinkedAccount[] {
  if (!Array.isArray(value) || value.length > MAX_LINKED_ACCOUNTS) {
    throw new KeycloakAccountContractError("linked-accounts");
  }
  const seen = new Set<string>();
  return value.map((account) => {
    if (
      !isObject(account) ||
      !hasOnlyKeys(account, linkedAccountKeys) ||
      typeof account.connected !== "boolean" ||
      typeof account.social !== "boolean" ||
      !requiredString(account.providerAlias, 255) ||
      !providerAlias.test(account.providerAlias) ||
      !optionalString(account.providerName) ||
      !optionalString(account.displayName) ||
      !optionalString(account.linkedUsername)
    ) {
      throw new KeycloakAccountContractError("linked-accounts");
    }
    if (seen.has(account.providerAlias)) throw new KeycloakAccountContractError("linked-accounts");
    seen.add(account.providerAlias);
    return {
      connected: account.connected,
      providerAlias: account.providerAlias,
      displayName: account.displayName?.trim() || null,
      linkedUsername: account.linkedUsername?.trim() || null,
      social: account.social,
    };
  });
}

const linkedAccountUriKeys = new Set(["accountLinkUri", "nonce", "hash"]);

export function parseLinkedAccountUri(value: unknown, issuer: URL, expectedProviderAlias: string): URL {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, linkedAccountUriKeys) ||
    !requiredString(value.accountLinkUri, 4_096) ||
    !requiredString(value.nonce, 255) ||
    !requiredString(value.hash, 255)
  ) {
    throw new KeycloakAccountContractError("linked-account-uri");
  }
  let uri: URL;
  try {
    uri = new URL(value.accountLinkUri);
  } catch {
    throw new KeycloakAccountContractError("linked-account-uri");
  }
  const realmPath = issuer.pathname.replace(/\/$/, "");
  if (
    uri.protocol !== "https:" ||
    uri.origin !== issuer.origin ||
    uri.username ||
    uri.password ||
    uri.hash ||
    uri.pathname !== `${realmPath}/broker/${encodeURIComponent(expectedProviderAlias)}/link` ||
    uri.searchParams.get("nonce") !== value.nonce ||
    uri.searchParams.get("hash") !== value.hash
  ) {
    throw new KeycloakAccountContractError("linked-account-uri");
  }
  return uri;
}
