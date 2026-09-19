import "server-only";

import type {
  AccountProfile,
  AccountSession,
  AuthenticationSummary,
} from "@/server/keycloak-account/types";

export class KeycloakAccountContractError extends Error {
  constructor(readonly resource: "profile" | "credentials" | "sessions" | "devices") {
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

function stringListMap(value: unknown) {
  return isObject(value) && Object.entries(value).every(([key, values]) =>
    key.length <= 255 &&
    Array.isArray(values) &&
    values.every((item) => typeof item === "string" && item.length <= 512),
  );
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
    (value.attributes !== undefined && value.attributes !== null && !stringListMap(value.attributes)) ||
    (value.userProfileMetadata !== undefined && value.userProfileMetadata !== null)
  ) {
    throw new KeycloakAccountContractError("profile");
  }
  return {
    firstName: value.firstName?.trim() || null,
    lastName: value.lastName?.trim() || null,
    email: value.email?.trim() || null,
    emailVerified: value.emailVerified,
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

export function parseAuthenticationSummary(value: unknown): AuthenticationSummary {
  if (!Array.isArray(value)) throw new KeycloakAccountContractError("credentials");
  const counts = new Map<string, number>();
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
    counts.set(container.type, container.userCredentialMetadatas?.length ?? 0);
  }
  return {
    passwordConfigured: (counts.get("password") ?? 0) > 0,
    otpConfigured: (counts.get("otp") ?? 0) + (counts.get("totp") ?? 0) > 0,
    passkeyCount: (counts.get("webauthn") ?? 0) + (counts.get("webauthn-passwordless") ?? 0),
  };
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
  const sessions = value.map((session) => {
    const parsed = parseSession(session, "sessions");
    if (seen.has(parsed.id)) throw new KeycloakAccountContractError("sessions");
    seen.add(parsed.id);
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
  return sessions.sort((left, right) =>
    Number(right.current) - Number(left.current) ||
    right.lastAccessAt.localeCompare(left.lastAccessAt),
  );
}
