// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  InvalidNativeBridgeRequestError,
  NativeBridgeRequestVerifier,
  signNativeBridgeRequest,
} from "@/server/auth/native-bridge-auth";
import { sha256 } from "@/server/auth/crypto";

const secret = Buffer.alloc(32, 9);
const fingerprint = "ab".repeat(32);
const now = new Date("2026-09-20T12:00:00Z");
const path = "/internal/v1/native-handoff/redeem";
const body = JSON.stringify({ code: "b".repeat(43) });
const timestamp = String(Math.floor(now.getTime() / 1_000));
const nonce = "n".repeat(32);

function requestHeaders(overrides: Record<string, string> = {}) {
  const requestFingerprint = overrides["x-sky-mtls-client-sha256"] ?? fingerprint;
  const requestTimestamp = overrides["x-sky-timestamp"] ?? timestamp;
  const requestNonce = overrides["x-sky-nonce"] ?? nonce;
  const requestSignature = overrides["x-sky-signature"] ?? signNativeBridgeRequest(secret, {
    method: "POST",
    path,
    timestamp: requestTimestamp,
    nonce: requestNonce,
    body,
  });
  return new Headers({
    "content-type": "application/json",
    "x-sky-mtls-client-sha256": requestFingerprint,
    "x-sky-timestamp": requestTimestamp,
    "x-sky-nonce": requestNonce,
    "x-sky-signature": requestSignature,
  });
}

describe("NativeBridgeRequestVerifier", () => {
  it("binds a fresh request to mTLS identity, method, path, nonce and exact body bytes", () => {
    const verifier = new NativeBridgeRequestVerifier(secret, fingerprint, () => now);

    expect(verifier.verify({ method: "POST", path, body, headers: requestHeaders() })).toEqual({
      requestNonceHash: sha256(nonce),
      requestNonceExpiresAt: new Date("2026-09-20T12:01:00Z"),
    });
  });

  it.each([
    ["missing mTLS proof", { "x-sky-mtls-client-sha256": "" }],
    ["wrong mTLS client", { "x-sky-mtls-client-sha256": "cd".repeat(32) }],
    ["wrong signature", { "x-sky-signature": "x".repeat(43) }],
    ["stale request", { "x-sky-timestamp": String(Number(timestamp) - 31) }],
    ["future request", { "x-sky-timestamp": String(Number(timestamp) + 31) }],
    ["malformed nonce", { "x-sky-nonce": "too-short" }],
    ["non-canonical nonce", { "x-sky-nonce": `${"A".repeat(21)}B` }],
    ["padded nonce", { "x-sky-nonce": Buffer.alloc(16).toString("base64") }],
    ["oversized nonce", { "x-sky-nonce": Buffer.alloc(65, 1).toString("base64url") }],
  ])("rejects %s with one generic error", (_name, overrides) => {
    const verifier = new NativeBridgeRequestVerifier(secret, fingerprint, () => now);

    expect(() => verifier.verify({
      method: "POST",
      path,
      body,
      headers: requestHeaders(overrides),
    })).toThrow(InvalidNativeBridgeRequestError);
  });

  it("rejects body tampering after the signature is created", () => {
    const verifier = new NativeBridgeRequestVerifier(secret, fingerprint, () => now);

    expect(() => verifier.verify({
      method: "POST",
      path,
      body: `${body} `,
      headers: requestHeaders(),
    })).toThrow(InvalidNativeBridgeRequestError);
  });

  it("rejects a correctly signed request for any path other than the fixed redemption path", () => {
    const rewrittenPath = "/internal/v1/native-handoff/redeem-shadow";
    const verifier = new NativeBridgeRequestVerifier(secret, fingerprint, () => now);
    const signature = signNativeBridgeRequest(secret, {
      method: "POST",
      path: rewrittenPath,
      timestamp,
      nonce,
      body,
    });

    expect(() => verifier.verify({
      method: "POST",
      path: rewrittenPath,
      body,
      headers: requestHeaders({ "x-sky-signature": signature }),
    })).toThrow(InvalidNativeBridgeRequestError);
  });

  it.each([16, 64])("accepts a canonical unpadded nonce containing %d decoded bytes", (bytes) => {
    const candidate = Buffer.alloc(bytes, 7).toString("base64url");
    const verifier = new NativeBridgeRequestVerifier(secret, fingerprint, () => now);

    expect(verifier.verify({
      method: "POST",
      path,
      body,
      headers: requestHeaders({ "x-sky-nonce": candidate }),
    })).toMatchObject({ requestNonceHash: sha256(candidate) });
  });
});
