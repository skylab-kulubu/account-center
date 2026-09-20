import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

type Envelope = {
  v: 1;
  kid: string;
  iv: string;
  ciphertext: string;
  tag: string;
};

export interface SecretCipher {
  encrypt(value: unknown, associatedData: string): string;
  decrypt<T>(envelope: string, associatedData: string): T;
}

function base64Url(value: Buffer) {
  return value.toString("base64url");
}

function parseEnvelope(serialized: string): Envelope {
  const value: unknown = JSON.parse(serialized);
  if (
    typeof value !== "object" ||
    value === null ||
    !("v" in value) ||
    value.v !== 1 ||
    !("kid" in value) ||
    typeof value.kid !== "string" ||
    !("iv" in value) ||
    typeof value.iv !== "string" ||
    !("ciphertext" in value) ||
    typeof value.ciphertext !== "string" ||
    !("tag" in value) ||
    typeof value.tag !== "string"
  ) {
    throw new Error("Invalid encrypted envelope.");
  }
  return value as Envelope;
}

export class AesGcmSecretCipher implements SecretCipher {
  readonly #key: Buffer;
  readonly #keyId: string;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("AES-256-GCM requires a 32-byte key.");
    this.#key = Buffer.from(key);
    this.#keyId = createHash("sha256").update(key).digest("base64url").slice(0, 12);
  }

  encrypt(value: unknown, associatedData: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const envelope: Envelope = {
      v: 1,
      kid: this.#keyId,
      iv: base64Url(iv),
      ciphertext: base64Url(ciphertext),
      tag: base64Url(cipher.getAuthTag()),
    };
    return JSON.stringify(envelope);
  }

  decrypt<T>(serialized: string, associatedData: string) {
    const envelope = parseEnvelope(serialized);
    if (envelope.kid !== this.#keyId) throw new Error("Unknown encryption key.");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }
}

export function randomOpaqueValue(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function sessionCsrfToken(secret: Buffer, sessionId: string) {
  return createHmac("sha256", secret).update(`account-center:csrf:v1:${sessionId}`, "utf8").digest("base64url");
}

export function upstreamSessionReference(
  secret: Buffer,
  browserSessionId: string,
  upstreamSessionId: string,
) {
  return hmacSha256(
    secret,
    "upstream-session-reference",
    `${browserSessionId}\0${upstreamSessionId}`,
  ).toString("base64url");
}

export function hmacSha256(secret: Buffer, purpose: string, value: string) {
  return createHmac("sha256", secret)
    .update(`account-center:${purpose}:v1:`, "utf8")
    .update(value, "utf8")
    .digest();
}

export function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
