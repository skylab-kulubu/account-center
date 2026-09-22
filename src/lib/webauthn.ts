/**
 * Browser-side WebAuthn plumbing for Sudo mode (assertion, `get`) and passkey
 * registration on the security page (attestation, `create`). Both ceremonies
 * run on `my.` with options produced by the sky-account SPI and relayed by
 * the BFF; this module only converts between the SPI's base64url JSON and the
 * `ArrayBuffer`s the platform API uses (`docs/sky-account-api.md`, "Passkey
 * ceremony akışı"). No third-party WebAuthn library is involved.
 */

const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const decodeTable = new Map<string, number>();
for (let index = 0; index < URL_ALPHABET.length; index += 1) decodeTable.set(URL_ALPHABET[index]!, index);

/** JSON shape of `POST sudo/webauthn/options` as relayed by `POST /api/account/sudo/webauthn/options`. */
export type AssertionOptionsJson = {
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
  userVerification: "required" | "preferred" | "discouraged";
  timeout?: number;
};

/**
 * JSON shape `POST /api/account/sudo/webauthn/verify` accepts under `assertion`:
 * exactly the members of the sudo contract. `authenticatorAttachment` and
 * client extension results are registration/page data and are not sent.
 */
export type AssertionJson = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
};

/** JSON shape of `POST credentials/webauthn/options` as relayed by `POST /api/account/security/passkeys/options`. */
export type CreationOptionsJson = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
  authenticatorSelection: {
    authenticatorAttachment?: "platform" | "cross-platform";
    residentKey?: "required" | "preferred" | "discouraged";
    requireResidentKey?: boolean;
    userVerification?: "required" | "preferred" | "discouraged";
  };
  attestation?: "none" | "indirect" | "direct" | "enterprise";
  extensions?: { credProps?: boolean };
};

/**
 * JSON shape `POST /api/account/security/passkeys/register` accepts under
 * `attestation`: the registration contract's members. `transports` and the
 * attachment are the browser's own report (Keycloak stores and checks them);
 * client extension results are page data and are not sent.
 */
export type AttestationJson = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  authenticatorAttachment?: "platform" | "cross-platform";
};

/** Unpadded RFC 4648 §5 encoding of a buffer or view. */
export function bufferToBase64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = index + 1 < bytes.length ? bytes[index + 1]! : null;
    const third = index + 2 < bytes.length ? bytes[index + 2]! : null;
    output += URL_ALPHABET[first >> 2];
    output += URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== null) output += URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third !== null) output += URL_ALPHABET[third & 0x3f];
  }
  return output;
}

/** Decodes base64url (padding optional); throws on the standard alphabet, whitespace or impossible lengths. */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  if (typeof value !== "string" || !BASE64URL.test(value)) throw new Error("Invalid base64url input.");
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.includes("=")) throw new Error("Invalid base64url input.");
  const remainder = unpadded.length % 4;
  if (remainder === 1) throw new Error("Invalid base64url length.");
  if (value.length > unpadded.length && (value.length % 4 !== 0 || remainder === 0)) {
    throw new Error("Invalid base64url padding.");
  }
  const bytes = new Uint8Array(Math.floor((unpadded.length * 3) / 4));
  let offset = 0;
  for (let index = 0; index < unpadded.length; index += 4) {
    const chunk = unpadded.slice(index, index + 4);
    const sextets = [...chunk].map((character) => decodeTable.get(character)!);
    const first = (sextets[0]! << 2) | (sextets[1]! >> 4);
    bytes[offset] = first;
    offset += 1;
    if (chunk.length > 2) {
      bytes[offset] = ((sextets[1]! & 0x0f) << 4) | (sextets[2]! >> 2);
      offset += 1;
    }
    if (chunk.length > 3) {
      bytes[offset] = ((sextets[2]! & 0x03) << 6) | sextets[3]!;
      offset += 1;
    }
  }
  return bytes.buffer;
}

/** Converts the SPI's assertion options into `PublicKeyCredentialRequestOptions`. */
export function toPublicKeyRequestOptions(options: AssertionOptionsJson): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlToBuffer(options.challenge),
    rpId: options.rpId,
    userVerification: options.userVerification,
    allowCredentials: options.allowCredentials.map((credential) => ({
      type: "public-key" as const,
      id: base64UrlToBuffer(credential.id),
      ...(credential.transports
        ? { transports: credential.transports as AuthenticatorTransport[] }
        : {}),
    })),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  };
}

/** Converts the SPI's creation options into `PublicKeyCredentialCreationOptions`. */
export function toPublicKeyCreationOptions(options: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    rp: { id: options.rp.id, name: options.rp.name },
    user: {
      id: base64UrlToBuffer(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: base64UrlToBuffer(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams.map((parameter) => ({
      type: "public-key" as const,
      alg: parameter.alg,
    })),
    excludeCredentials: options.excludeCredentials.map((credential) => ({
      type: "public-key" as const,
      id: base64UrlToBuffer(credential.id),
      ...(credential.transports
        ? { transports: credential.transports as AuthenticatorTransport[] }
        : {}),
    })),
    authenticatorSelection: { ...options.authenticatorSelection },
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.attestation !== undefined ? { attestation: options.attestation } : {}),
    ...(options.extensions?.credProps !== undefined
      ? { extensions: { credProps: options.extensions.credProps } }
      : {}),
  };
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]" || ArrayBuffer.isView(value);
}

function isAssertionResponse(value: unknown): value is AuthenticatorAssertionResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return isBinary(response.clientDataJSON) && isBinary(response.authenticatorData) && isBinary(response.signature);
}

/**
 * Serializes the `PublicKeyCredential` returned by `navigator.credentials.get()`
 * into the JSON the SPI verifies. Built by hand rather than through
 * `PublicKeyCredential.toJSON()` so the shape does not depend on the browser.
 */
export function serializeAssertion(credential: PublicKeyCredential): AssertionJson {
  if (credential.type !== "public-key") throw new Error("Not a public-key credential.");
  const rawId = bufferToBase64Url(credential.rawId);
  if (credential.id !== rawId) throw new Error("Credential id and rawId disagree.");
  const response: unknown = credential.response;
  if (!isAssertionResponse(response)) throw new Error("Not an assertion response.");
  return {
    id: credential.id,
    rawId,
    type: "public-key",
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      ...(response.userHandle ? { userHandle: bufferToBase64Url(response.userHandle) } : {}),
    },
  };
}

function isAttestationResponse(value: unknown): value is AuthenticatorAttestationResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return isBinary(response.clientDataJSON) && isBinary(response.attestationObject);
}

const TRANSPORT = /^[a-z][a-z0-9-]{0,31}$/;

function reportedTransports(response: AuthenticatorAttestationResponse): string[] | undefined {
  const getTransports = (response as { getTransports?: unknown }).getTransports;
  if (typeof getTransports !== "function") return undefined;
  let reported: unknown;
  try {
    reported = getTransports.call(response);
  } catch {
    return undefined;
  }
  if (!Array.isArray(reported)) return undefined;
  const transports = reported.filter((item): item is string => typeof item === "string" && TRANSPORT.test(item));
  return transports.length > 0 ? transports.slice(0, 8) : undefined;
}

/**
 * Serializes the `PublicKeyCredential` returned by `navigator.credentials.create()`
 * into the JSON the SPI registers. Built by hand rather than through
 * `PublicKeyCredential.toJSON()` so the shape does not depend on the browser.
 */
export function serializeAttestation(credential: PublicKeyCredential): AttestationJson {
  if (credential.type !== "public-key") throw new Error("Not a public-key credential.");
  const rawId = bufferToBase64Url(credential.rawId);
  if (credential.id !== rawId) throw new Error("Credential id and rawId disagree.");
  const response: unknown = credential.response;
  if (!isAttestationResponse(response)) throw new Error("Not an attestation response.");
  const transports = reportedTransports(response);
  const attachment = credential.authenticatorAttachment;
  return {
    id: credential.id,
    rawId,
    type: "public-key",
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      ...(transports ? { transports } : {}),
    },
    ...(attachment === "platform" || attachment === "cross-platform" ? { authenticatorAttachment: attachment } : {}),
  };
}

/** Whether this browser can run the passkey assertion ceremony (Sudo mode) at all. */
export function webauthnSupported() {
  return typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.get === "function";
}

/** Whether this browser can register a passkey (`navigator.credentials.create()`). */
export function webauthnCreateSupported() {
  return typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function";
}
