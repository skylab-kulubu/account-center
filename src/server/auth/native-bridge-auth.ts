import "server-only";

import { createHash, createHmac } from "node:crypto";
import { constantTimeEqual, sha256 } from "@/server/auth/crypto";

const redemptionPath = "/internal/v1/native-handoff/redeem";
const signatureWindowSeconds = 30;
const nonceRetentionSeconds = 60;

type SignatureInput = {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
};

export class InvalidNativeBridgeRequestError extends Error {
  constructor() {
    super("The native bridge request is invalid.");
    this.name = "InvalidNativeBridgeRequestError";
  }
}

function signaturePayload(input: SignatureInput) {
  const bodyDigest = createHash("sha256").update(input.body, "utf8").digest("base64url");
  return `v1\n${input.method}\n${input.path}\n${input.timestamp}\n${input.nonce}\n${bodyDigest}`;
}

function validNonce(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 16 &&
    decoded.length <= 64 &&
    decoded.toString("base64url") === value;
}

export function signNativeBridgeRequest(secret: Buffer, input: SignatureInput) {
  return createHmac("sha256", secret).update(signaturePayload(input), "utf8").digest("base64url");
}

export class NativeBridgeRequestVerifier {
  constructor(
    private readonly hmacSecret: Buffer,
    private readonly mtlsClientFingerprint: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  verify(input: { method: string; path: string; body: string; headers: Headers }) {
    try {
      const fingerprint = input.headers.get("x-sky-mtls-client-sha256") ?? "";
      const timestamp = input.headers.get("x-sky-timestamp") ?? "";
      const nonce = input.headers.get("x-sky-nonce") ?? "";
      const signature = input.headers.get("x-sky-signature") ?? "";
      if (
        input.method !== "POST" ||
        input.path !== redemptionPath ||
        !/^[a-f0-9]{64}$/.test(fingerprint) ||
        !constantTimeEqual(fingerprint, this.mtlsClientFingerprint) ||
        !/^\d{10}$/.test(timestamp) ||
        !validNonce(nonce) ||
        !/^[A-Za-z0-9_-]{43}$/.test(signature)
      ) {
        throw new InvalidNativeBridgeRequestError();
      }
      const now = this.clock();
      const signedAtSeconds = Number(timestamp);
      const nowSeconds = Math.floor(now.getTime() / 1_000);
      if (
        !Number.isSafeInteger(signedAtSeconds) ||
        Math.abs(nowSeconds - signedAtSeconds) > signatureWindowSeconds
      ) {
        throw new InvalidNativeBridgeRequestError();
      }
      const expected = signNativeBridgeRequest(this.hmacSecret, {
        method: input.method,
        path: input.path,
        timestamp,
        nonce,
        body: input.body,
      });
      if (!constantTimeEqual(signature, expected)) throw new InvalidNativeBridgeRequestError();
      return {
        requestNonceHash: sha256(nonce),
        requestNonceExpiresAt: new Date(now.getTime() + nonceRetentionSeconds * 1_000),
      };
    } catch {
      throw new InvalidNativeBridgeRequestError();
    }
  }
}
