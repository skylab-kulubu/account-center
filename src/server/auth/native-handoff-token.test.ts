// @vitest-environment node

import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  InvalidNativeAccessTokenError,
  NativeAccessTokenVerifier,
} from "@/server/auth/native-handoff-token";

const issuer = "https://e.yildizskylab.com/realms/e-skylab";
const now = new Date("2026-09-20T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);

describe("NativeAccessTokenVerifier", () => {
  let rs256: Awaited<ReturnType<typeof generateKeyPair>>;
  let es256: Awaited<ReturnType<typeof generateKeyPair>>;

  beforeAll(async () => {
    rs256 = await generateKeyPair("RS256", { modulusLength: 2048 });
    es256 = await generateKeyPair("ES256");
  });

  async function token(overrides: Record<string, unknown> = {}, algorithm = "RS256") {
    const key = algorithm === "RS256" ? rs256.privateKey : es256.privateKey;
    return new SignJWT({
      iss: issuer,
      aud: "account-center",
      sub: "user-id",
      iat: nowSeconds - 30,
      exp: nowSeconds + 300,
      azp: "skyapp",
      sid: "native-session-id",
      auth_time: nowSeconds - 120,
      ...overrides,
    })
      .setProtectedHeader({ alg: algorithm, kid: "native-test-key", typ: "JWT" })
      .sign(key);
  }

  function verifier() {
    return new NativeAccessTokenVerifier(
      new URL(issuer),
      async () => rs256.publicKey,
      () => now,
    );
  }

  it("accepts only the pinned issuer, audience, authorized party and RS256 signature", async () => {
    await expect(verifier().verify(await token())).resolves.toEqual({
      subject: "user-id",
      keycloakSid: "native-session-id",
      authenticatedAt: new Date((nowSeconds - 120) * 1_000),
      expiresAt: new Date((nowSeconds + 300) * 1_000),
    });
  });

  it.each([
    ["issuer", { iss: "https://attacker.invalid/realms/e-skylab" }],
    ["audience", { aud: "different-client" }],
    ["authorized party", { azp: "different-app" }],
    ["subject", { sub: "" }],
    ["session id", { sid: "" }],
    ["authentication time", { auth_time: "1789900000" }],
    ["future authentication time", { auth_time: nowSeconds + 1 }],
    ["expired token", { exp: nowSeconds - 1 }],
    ["missing expiry", { exp: undefined }],
    ["missing audience", { aud: undefined }],
  ])("rejects the wrong %s contract", async (_name, overrides) => {
    await expect(verifier().verify(await token(overrides))).rejects.toBeInstanceOf(
      InvalidNativeAccessTokenError,
    );
  });

  it("rejects a correctly signed token that uses an unpinned algorithm", async () => {
    await expect(verifier().verify(await token({}, "ES256"))).rejects.toBeInstanceOf(
      InvalidNativeAccessTokenError,
    );
  });

  it("accepts Keycloak audience arrays only when they include account-center", async () => {
    await expect(verifier().verify(await token({
      aud: ["core", "account-center", "skyapp"],
    }))).resolves.toMatchObject({ subject: "user-id" });
  });
});
