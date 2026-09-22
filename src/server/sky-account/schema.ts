import "server-only";

import { COMPACT_JWS } from "@/server/contract-shapes";
import { SkyAccountContractError } from "@/server/sky-account/problem";
import type {
  SkyAccountCredential,
  SkyAccountIdentity,
  SudoGrant,
  TotpSetup,
  WebauthnAssertion,
  WebauthnAssertionOptions,
} from "@/server/sky-account/types";

/**
 * Response parsers for sky-account v1. Every documented member is validated
 * strictly; members this version does not know are ignored so that additive
 * releases of the extension (passkey transports, e-mail change state, QR data)
 * never fail the BFF closed. Requests still carry only documented members.
 */

type JsonObject = Record<string, unknown>;

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const BASE32 = /^[A-Z2-7]{16,128}={0,6}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,255}$/;
/** RFC 4648 §5 without padding, as the SPI produces; padded input is accepted too. */
const BASE64URL_BYTES = /^[A-Za-z0-9_-]+={0,2}$/;
const WEBAUTHN_CHALLENGE_LENGTH = 1_024;
const WEBAUTHN_CREDENTIAL_ID_LENGTH = 1_366;
const WEBAUTHN_CLIENT_DATA_LENGTH = 8_192;
const WEBAUTHN_AUTHENTICATOR_DATA_LENGTH = 8_192;
const WEBAUTHN_SIGNATURE_LENGTH = 4_096;
const WEBAUTHN_USER_HANDLE_LENGTH = 1_024;
const WEBAUTHN_TRANSPORT = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_ALLOW_CREDENTIALS = 64;
const MAX_TRANSPORTS = 8;
const MAX_WEBAUTHN_TIMEOUT_MS = 60 * 60 * 1_000;
const userVerificationValues = new Set(["required", "preferred", "discouraged"]);
const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_CREDENTIALS = 64;
const credentialTypes = new Set(["otp", "webauthn-passwordless", "webauthn"]);
const primaryValues = new Set(["school", "personal", "none"]);
const otpAlgorithms = new Set(["SHA1", "SHA256", "SHA512"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, maximum = 512): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maximum);
}

function requiredString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isoInstant(value: unknown): value is string {
  return typeof value === "string" && RFC3339_UTC.test(value) && Number.isFinite(Date.parse(value));
}

export function parseCredential(value: unknown): SkyAccountCredential {
  if (
    !isObject(value) ||
    !requiredString(value.id, 255) ||
    !CREDENTIAL_ID.test(value.id) ||
    typeof value.type !== "string" ||
    !credentialTypes.has(value.type) ||
    !nullableString(value.label, 255) ||
    (value.createdAt !== null && !isoInstant(value.createdAt))
  ) {
    throw new SkyAccountContractError();
  }
  return {
    id: value.id,
    type: value.type as SkyAccountCredential["type"],
    label: value.label?.trim() || null,
    createdAt: value.createdAt as string | null,
  };
}

function parseCredentialList(value: unknown, allowed: ReadonlySet<string>) {
  if (!Array.isArray(value) || value.length > MAX_CREDENTIALS) throw new SkyAccountContractError();
  const seen = new Set<string>();
  return value.map((item) => {
    const credential = parseCredential(item);
    if (!allowed.has(credential.type) || seen.has(credential.id)) throw new SkyAccountContractError();
    seen.add(credential.id);
    return credential;
  });
}

const totpTypes = new Set(["otp"]);
const passkeyTypes = new Set(["webauthn-passwordless", "webauthn"]);

export function parseIdentity(value: unknown): SkyAccountIdentity {
  if (
    !isObject(value) ||
    !requiredString(value.sub, 255) ||
    !requiredString(value.username, 255) ||
    !nullableString(value.firstName, 255) ||
    !nullableString(value.lastName, 255) ||
    !nullableString(value.email, 320) ||
    typeof value.emailVerified !== "boolean" ||
    !nullableString(value.schoolEmail, 320) ||
    !nullableString(value.personalEmail, 320) ||
    typeof value.primary !== "string" ||
    !primaryValues.has(value.primary) ||
    typeof value.verifiedYtu !== "boolean" ||
    typeof value.nameLocked !== "boolean" ||
    (value.usernameChangeAvailableAt !== null && !isoInstant(value.usernameChangeAvailableAt)) ||
    !isObject(value.credentials) ||
    typeof value.credentials.password !== "boolean"
  ) {
    throw new SkyAccountContractError();
  }
  return {
    sub: value.sub,
    username: value.username,
    firstName: value.firstName,
    lastName: value.lastName,
    email: value.email,
    emailVerified: value.emailVerified,
    schoolEmail: value.schoolEmail,
    personalEmail: value.personalEmail,
    primary: value.primary as SkyAccountIdentity["primary"],
    verifiedYtu: value.verifiedYtu,
    nameLocked: value.nameLocked,
    usernameChangeAvailableAt: value.usernameChangeAvailableAt as string | null,
    credentials: {
      password: value.credentials.password,
      totp: parseCredentialList(value.credentials.totp, totpTypes),
      passkeys: parseCredentialList(value.credentials.passkeys, passkeyTypes),
    },
  };
}

export function parseSudoGrant(value: unknown): SudoGrant {
  if (
    !isObject(value) ||
    typeof value.sudoToken !== "string" ||
    !COMPACT_JWS.test(value.sudoToken) ||
    !isoInstant(value.expiresAt)
  ) {
    throw new SkyAccountContractError();
  }
  return { sudoToken: value.sudoToken, expiresAt: new Date(value.expiresAt) };
}

export function parseTotpSetup(value: unknown): TotpSetup {
  if (
    !isObject(value) ||
    typeof value.setupHandle !== "string" ||
    !BASE64URL.test(value.setupHandle) ||
    typeof value.secret !== "string" ||
    !BASE32.test(value.secret) ||
    typeof value.otpauthUri !== "string" ||
    value.otpauthUri.length > 2_048 ||
    !value.otpauthUri.startsWith("otpauth://totp/") ||
    !isoInstant(value.expiresAt) ||
    !isObject(value.policy) ||
    value.policy.type !== "totp" ||
    typeof value.policy.algorithm !== "string" ||
    !otpAlgorithms.has(value.policy.algorithm) ||
    (value.policy.digits !== 6 && value.policy.digits !== 8) ||
    typeof value.policy.period !== "number" ||
    !Number.isSafeInteger(value.policy.period) ||
    value.policy.period < 1 ||
    value.policy.period > 3_600
  ) {
    throw new SkyAccountContractError();
  }
  return {
    setupHandle: value.setupHandle,
    secret: value.secret,
    otpauthUri: value.otpauthUri,
    expiresAt: new Date(value.expiresAt),
    policy: {
      type: "totp",
      algorithm: value.policy.algorithm as TotpSetup["policy"]["algorithm"],
      digits: value.policy.digits,
      period: value.policy.period,
    },
  };
}

function base64UrlBytes(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    BASE64URL_BYTES.test(value) &&
    (value.replace(/=+$/, "").length % 4) !== 1;
}

function parseTransports(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_TRANSPORTS ||
    !value.every((transport) => typeof transport === "string" && WEBAUTHN_TRANSPORT.test(transport))
  ) {
    throw new SkyAccountContractError();
  }
  return [...(value as string[])];
}

export function parseWebauthnAssertionOptions(value: unknown): WebauthnAssertionOptions {
  if (
    !isObject(value) ||
    !base64UrlBytes(value.challenge, WEBAUTHN_CHALLENGE_LENGTH) ||
    !requiredString(value.rpId, 253) ||
    !Array.isArray(value.allowCredentials) ||
    value.allowCredentials.length > MAX_ALLOW_CREDENTIALS ||
    typeof value.userVerification !== "string" ||
    !userVerificationValues.has(value.userVerification) ||
    (value.timeout !== undefined &&
      (typeof value.timeout !== "number" ||
        !Number.isSafeInteger(value.timeout) ||
        value.timeout < 1 ||
        value.timeout > MAX_WEBAUTHN_TIMEOUT_MS))
  ) {
    throw new SkyAccountContractError();
  }
  const seen = new Set<string>();
  const allowCredentials = value.allowCredentials.map((item) => {
    if (
      !isObject(item) ||
      item.type !== "public-key" ||
      !base64UrlBytes(item.id, WEBAUTHN_CREDENTIAL_ID_LENGTH) ||
      seen.has(item.id)
    ) {
      throw new SkyAccountContractError();
    }
    seen.add(item.id);
    const transports = parseTransports(item.transports);
    return {
      type: "public-key" as const,
      id: item.id,
      ...(transports ? { transports } : {}),
    };
  });
  return {
    challenge: value.challenge,
    rpId: value.rpId,
    allowCredentials,
    userVerification: value.userVerification as WebauthnAssertionOptions["userVerification"],
    ...(value.timeout !== undefined ? { timeout: value.timeout } : {}),
  };
}

/**
 * Validates the `PublicKeyCredential` JSON the browser produced for
 * `POST sudo/webauthn/verify`. Only the members the sudo contract lists are
 * copied: `authenticatorAttachment` (registration only) and the free-form
 * `clientExtensionResults` are dropped, because the SPI rejects unknown
 * members and must never see anything the page added. The assertion itself
 * stays opaque.
 */
export function parseWebauthnAssertion(value: unknown): WebauthnAssertion | null {
  if (
    !isObject(value) ||
    !base64UrlBytes(value.id, WEBAUTHN_CREDENTIAL_ID_LENGTH) ||
    value.rawId !== value.id ||
    value.type !== "public-key" ||
    !isObject(value.response) ||
    !base64UrlBytes(value.response.clientDataJSON, WEBAUTHN_CLIENT_DATA_LENGTH) ||
    !base64UrlBytes(value.response.authenticatorData, WEBAUTHN_AUTHENTICATOR_DATA_LENGTH) ||
    !base64UrlBytes(value.response.signature, WEBAUTHN_SIGNATURE_LENGTH) ||
    (value.response.userHandle !== undefined &&
      value.response.userHandle !== null &&
      !base64UrlBytes(value.response.userHandle, WEBAUTHN_USER_HANDLE_LENGTH)) ||
    (value.clientExtensionResults !== undefined && !isObject(value.clientExtensionResults))
  ) {
    return null;
  }
  const response = value.response as {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
  return {
    id: value.id,
    rawId: value.id,
    type: "public-key",
    response: {
      clientDataJSON: response.clientDataJSON,
      authenticatorData: response.authenticatorData,
      signature: response.signature,
      ...(typeof response.userHandle === "string" ? { userHandle: response.userHandle } : {}),
    },
  };
}
