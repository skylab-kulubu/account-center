// @vitest-environment node

import { describe, expect, it } from "vitest";
import assertionFixture from "../../tests/fixtures/sky-account-v1-webauthn-assertion.json";
import assertionOptionsJson from "../../tests/fixtures/sky-account-v1-webauthn-assertion-options.json";
import attestationFixture from "../../tests/fixtures/sky-account-v1-webauthn-attestation.json";
import registrationOptionsJson from "../../tests/fixtures/sky-account-v1-webauthn-registration-options.json";
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  serializeAssertion,
  serializeAttestation,
  toPublicKeyCreationOptions,
  toPublicKeyRequestOptions,
  webauthnCreateSupported,
  webauthnSupported,
} from "@/lib/webauthn";
import type { AssertionOptionsJson, CreationOptionsJson } from "@/lib/webauthn";

const assertionOptionsFixture = assertionOptionsJson as AssertionOptionsJson;
const registrationOptionsFixture = registrationOptionsJson as CreationOptionsJson;

/** RFC 4648 §10 test vectors, base64url alphabet, unpadded (contract: padding-free output, padded input accepted). */
const vectors: Array<[string, string]> = [
  ["", ""],
  ["f", "Zg"],
  ["fo", "Zm8"],
  ["foo", "Zm9v"],
  ["foob", "Zm9vYg"],
  ["fooba", "Zm9vYmE"],
  ["foobar", "Zm9vYmFy"],
];

function bytes(text: string) {
  return new TextEncoder().encode(text);
}

function list(value: ArrayBuffer | ArrayBufferView) {
  return Array.from(ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value));
}

describe("webauthn base64url helpers", () => {
  it("encodes bytes as unpadded RFC 4648 §5 base64url", () => {
    for (const [plain, encoded] of vectors) {
      expect(bufferToBase64Url(bytes(plain))).toBe(encoded);
      expect(bufferToBase64Url(bytes(plain).buffer)).toBe(encoded);
    }
    expect(bufferToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x3f]))).toBe("-_-_Pj8");
    expect(bufferToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x3f]))).not.toMatch(/[+/=]/);
  });

  it("decodes padded and unpadded base64url back to the same bytes", () => {
    for (const [plain, encoded] of vectors) {
      expect(list(base64UrlToBuffer(encoded))).toEqual(list(bytes(plain)));
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      expect(list(base64UrlToBuffer(padded))).toEqual(list(bytes(plain)));
    }
    expect(list(base64UrlToBuffer("-_-_Pj8"))).toEqual([0xfb, 0xff, 0xbf, 0x3e, 0x3f]);
  });

  it("rejects the standard alphabet, whitespace and impossible lengths", () => {
    for (const value of ["Zm9v+", "Zm9v/", "Zm 9v", "Zm9v\n", "Z", "Zm9vY", "Zm9v===", "Zg=", "%%%"]) {
      expect(() => base64UrlToBuffer(value)).toThrow(/base64url/);
    }
  });

  it("round-trips arbitrary byte sequences", () => {
    const sample = new Uint8Array(257);
    for (let index = 0; index < sample.length; index += 1) sample[index] = (index * 37 + 11) % 256;
    const encoded = bufferToBase64Url(sample);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(list(base64UrlToBuffer(encoded))).toEqual(list(sample));
    const view = new Uint8Array(sample.buffer, 7, 100);
    expect(list(base64UrlToBuffer(bufferToBase64Url(view)))).toEqual(list(sample.slice(7, 107)));
  });
});

describe("assertion options conversion", () => {
  it("converts the SPI options into what navigator.credentials.get() expects", () => {
    const options = toPublicKeyRequestOptions(assertionOptionsFixture);
    expect(bufferToBase64Url(options.challenge as ArrayBuffer)).toBe(assertionOptionsFixture.challenge);
    expect(options.rpId).toBe("yildizskylab.com");
    expect(options.userVerification).toBe("required");
    expect(options.timeout).toBe(90_000);
    expect(options.allowCredentials).toHaveLength(1);
    const [credential] = options.allowCredentials!;
    expect(credential?.type).toBe("public-key");
    expect(bufferToBase64Url(credential!.id as ArrayBuffer)).toBe(assertionOptionsFixture.allowCredentials[0]!.id);
    expect(credential?.transports).toEqual(["internal", "hybrid"]);
  });

  it("omits absent optional members instead of inventing them", () => {
    const { timeout: _timeout, ...withoutTimeout } = assertionOptionsFixture;
    void _timeout;
    const options = toPublicKeyRequestOptions({
      ...withoutTimeout,
      allowCredentials: [{ type: "public-key", id: assertionOptionsFixture.allowCredentials[0]!.id }],
    });
    expect("timeout" in options).toBe(false);
    expect("transports" in options.allowCredentials![0]!).toBe(false);
  });
});

describe("assertion serialization", () => {
  function fakeCredential(overrides: Partial<{ id: string; type: string; authenticatorAttachment: string | null }> = {}) {
    const rawId = base64UrlToBuffer(assertionFixture.rawId);
    const response = assertionFixture.response;
    return {
      id: overrides.id ?? assertionFixture.id,
      type: overrides.type ?? "public-key",
      rawId,
      authenticatorAttachment: overrides.authenticatorAttachment === undefined ? "platform" : overrides.authenticatorAttachment,
      response: {
        clientDataJSON: base64UrlToBuffer(response.clientDataJSON),
        authenticatorData: base64UrlToBuffer(response.authenticatorData),
        signature: base64UrlToBuffer(response.signature),
        userHandle: base64UrlToBuffer(response.userHandle),
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    } as unknown as PublicKeyCredential;
  }

  it("produces exactly the sudo contract's members, base64url, with id == rawId", () => {
    const serialized = serializeAssertion(fakeCredential());
    expect(serialized).toEqual({
      id: assertionFixture.id,
      rawId: assertionFixture.rawId,
      type: "public-key",
      response: assertionFixture.response,
    });
    expect(Object.keys(serialized)).toEqual(["id", "rawId", "type", "response"]);
    expect(JSON.stringify(serialized)).not.toMatch(/authenticatorAttachment|clientExtensionResults/);
    const clientData = JSON.parse(new TextDecoder().decode(base64UrlToBuffer(assertionFixture.response.clientDataJSON)));
    expect(clientData).toMatchObject({ type: "webauthn.get", challenge: assertionOptionsFixture.challenge });
  });

  it("drops a null user handle and refuses a credential whose id disagrees with rawId", () => {
    const rawId = base64UrlToBuffer(assertionFixture.rawId);
    const minimal = {
      id: assertionFixture.id,
      type: "public-key",
      rawId,
      authenticatorAttachment: null,
      response: {
        clientDataJSON: base64UrlToBuffer(assertionFixture.response.clientDataJSON),
        authenticatorData: base64UrlToBuffer(assertionFixture.response.authenticatorData),
        signature: base64UrlToBuffer(assertionFixture.response.signature),
        userHandle: null,
      },
    } as unknown as PublicKeyCredential;
    const serialized = serializeAssertion(minimal);
    expect("userHandle" in serialized.response).toBe(false);

    expect(() => serializeAssertion(fakeCredential({ id: "someone-elses-id" }))).toThrow(/rawId/);
    expect(() => serializeAssertion(fakeCredential({ type: "password" }))).toThrow(/public-key/);
    expect(() => serializeAssertion({ ...fakeCredential(), response: {} } as unknown as PublicKeyCredential)).toThrow(/assertion/);
  });
});

describe("creation options conversion", () => {
  it("converts the SPI options into what navigator.credentials.create() expects", () => {
    const options = toPublicKeyCreationOptions(registrationOptionsFixture);
    expect(options.rp).toEqual({ id: "yildizskylab.com", name: "SKY LAB" });
    expect(bufferToBase64Url(options.challenge as ArrayBuffer)).toBe(registrationOptionsFixture.challenge);
    expect(bufferToBase64Url(options.user.id as ArrayBuffer)).toBe(registrationOptionsFixture.user.id);
    expect(new TextDecoder().decode(options.user.id as ArrayBuffer)).toBe("11111111-1111-4111-8111-111111111111");
    expect(options.user.name).toBe("account-fixture");
    expect(options.user.displayName).toBe("Ada Lovelace");
    expect(options.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }]);
    expect(options.timeout).toBe(90_000);
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(options.extensions).toEqual({ credProps: true });
    expect(options.excludeCredentials).toHaveLength(1);
    const [excluded] = options.excludeCredentials!;
    expect(excluded?.type).toBe("public-key");
    expect(bufferToBase64Url(excluded!.id as ArrayBuffer)).toBe(registrationOptionsFixture.excludeCredentials[0]!.id);
    expect(excluded?.transports).toEqual(["internal", "hybrid"]);
  });

  it("omits absent optional members instead of inventing them", () => {
    const { timeout: _timeout, attestation: _attestation, extensions: _extensions, ...bare } = registrationOptionsFixture;
    void _timeout;
    void _attestation;
    void _extensions;
    const options = toPublicKeyCreationOptions({
      ...bare,
      excludeCredentials: [],
      authenticatorSelection: {},
    });
    expect("timeout" in options).toBe(false);
    expect("attestation" in options).toBe(false);
    expect("extensions" in options).toBe(false);
    expect(options.excludeCredentials).toEqual([]);
    expect(options.authenticatorSelection).toEqual({});
  });
});

describe("attestation serialization", () => {
  function fakeCredential(overrides: {
    id?: string;
    type?: string;
    authenticatorAttachment?: string | null;
    transports?: unknown;
    withTransports?: boolean;
  } = {}) {
    const rawId = base64UrlToBuffer(attestationFixture.rawId);
    const response: Record<string, unknown> = {
      clientDataJSON: base64UrlToBuffer(attestationFixture.response.clientDataJSON),
      attestationObject: base64UrlToBuffer(attestationFixture.response.attestationObject),
    };
    if (overrides.withTransports !== false) {
      response.getTransports = () => overrides.transports ?? attestationFixture.response.transports;
    }
    return {
      id: overrides.id ?? attestationFixture.id,
      type: overrides.type ?? "public-key",
      rawId,
      authenticatorAttachment: overrides.authenticatorAttachment === undefined ? "platform" : overrides.authenticatorAttachment,
      response,
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    } as unknown as PublicKeyCredential;
  }

  it("produces exactly the registration contract's members, base64url, with id == rawId", () => {
    const serialized = serializeAttestation(fakeCredential());
    expect(serialized).toEqual({
      id: attestationFixture.id,
      rawId: attestationFixture.rawId,
      type: "public-key",
      response: attestationFixture.response,
      authenticatorAttachment: "platform",
    });
    expect(Object.keys(serialized)).toEqual(["id", "rawId", "type", "response", "authenticatorAttachment"]);
    expect(JSON.stringify(serialized)).not.toMatch(/clientExtensionResults|credProps/);
    const clientData = JSON.parse(new TextDecoder().decode(base64UrlToBuffer(attestationFixture.response.clientDataJSON)));
    expect(clientData).toMatchObject({ type: "webauthn.create", challenge: registrationOptionsFixture.challenge });
  });

  it("drops unknown attachments and unreported or malformed transports", () => {
    const anonymous = serializeAttestation(fakeCredential({ authenticatorAttachment: null, withTransports: false }));
    expect("authenticatorAttachment" in anonymous).toBe(false);
    expect("transports" in anonymous.response).toBe(false);
    const odd = serializeAttestation(fakeCredential({ authenticatorAttachment: "roaming", transports: ["usb", 42, "Bad!"] }));
    expect("authenticatorAttachment" in odd).toBe(false);
    expect(odd.response.transports).toEqual(["usb"]);
    const empty = serializeAttestation(fakeCredential({ transports: [] }));
    expect("transports" in empty.response).toBe(false);
    const throwing = fakeCredential();
    (throwing.response as unknown as { getTransports: () => never }).getTransports = () => { throw new Error("unsupported"); };
    expect("transports" in serializeAttestation(throwing).response).toBe(false);
  });

  it("refuses a credential whose id disagrees with rawId or that is not an attestation", () => {
    expect(() => serializeAttestation(fakeCredential({ id: "someone-elses-id" }))).toThrow(/rawId/);
    expect(() => serializeAttestation(fakeCredential({ type: "password" }))).toThrow(/public-key/);
    expect(() => serializeAttestation({ ...fakeCredential(), response: {} } as unknown as PublicKeyCredential)).toThrow(/attestation/);
  });
});

describe("platform support probes", () => {
  it("report the ceremony this environment can run", () => {
    // Node has no window: neither ceremony is available and nothing throws.
    expect(webauthnSupported()).toBe(false);
    expect(webauthnCreateSupported()).toBe(false);
  });
});
