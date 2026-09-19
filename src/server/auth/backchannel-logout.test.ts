import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BackchannelLogoutReplayError,
  BackchannelLogoutService,
  InvalidBackchannelLogoutError,
  KeycloakBackchannelLogoutVerifier,
} from "@/server/auth/backchannel-logout";
import type { AuthConfig } from "@/server/auth/config";
import type {
  BackchannelLogoutInput,
  BackchannelLogoutRepository,
} from "@/server/auth/repositories";

const now = new Date("2026-09-20T00:00:00Z");
const issuer = "https://e.yildizskylab.com/realms/e-skylab";
const clientId = "account-center";
let privateKey: CryptoKey;
let verifier: KeycloakBackchannelLogoutVerifier;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = "test-key";
  verifier = new KeycloakBackchannelLogoutVerifier(
    { issuer: new URL(issuer), clientId } as AuthConfig,
    createLocalJWKSet({ keys: [publicJwk] }),
    () => now,
  );
});

function logoutToken(
  overrides: Record<string, unknown> = {},
  protectedHeader: { typ?: string } = { typ: "logout+jwt" },
) {
  return new SignJWT({
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    sid: "keycloak-session",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key", ...protectedHeader })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setJti("logout-jti-0001")
    .sign(privateKey);
}

class MemoryLogoutRepository implements BackchannelLogoutRepository {
  seen = new Set<string>();
  inputs: BackchannelLogoutInput[] = [];

  async consumeAndDeleteSessions(input: BackchannelLogoutInput) {
    const key = input.jtiHash.toString("hex");
    if (this.seen.has(key)) return { accepted: false, deletedSessions: 0 };
    this.seen.add(key);
    this.inputs.push(input);
    return { accepted: true, deletedSessions: 2 };
  }
}

describe("Keycloak backchannel logout", () => {
  it("verifies RS256 issuer, audience, event, iat, jti, and sid", async () => {
    await expect(verifier.verify(await logoutToken())).resolves.toEqual({
      jti: "logout-jti-0001",
      issuedAt: Math.floor(now.getTime() / 1_000),
      keycloakSid: "keycloak-session",
    });
  });

  it("rejects invalid audience, missing event, nonce, and stale tokens", async () => {
    const wrongAudience = await new SignJWT({
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      sid: "keycloak-session",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "logout+jwt" })
      .setIssuer(issuer)
      .setAudience("different-client")
      .setIssuedAt(Math.floor(now.getTime() / 1_000))
      .setJti("logout-jti-0002")
      .sign(privateKey);
    await expect(verifier.verify(wrongAudience)).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);
    await expect(verifier.verify(await logoutToken({ events: {} }))).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);
    await expect(
      verifier.verify(
        await logoutToken({
          events: {
            "http://schemas.openid.net/event/backchannel-logout": { unexpected: true },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);
    await expect(
      verifier.verify(
        await logoutToken({
          events: { "http://schemas.openid.net/event/backchannel-logout": null },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);
    await expect(
      verifier.verify(
        await logoutToken({
          events: { "http://schemas.openid.net/event/backchannel-logout": [] },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);
    await expect(verifier.verify(await logoutToken({ nonce: "forbidden" }))).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);

    const stale = await new SignJWT({
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      sub: "user-id",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "logout+jwt" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt(Math.floor(now.getTime() / 1_000) - 306)
      .setJti("logout-jti-stale")
      .sign(privateKey);
    await expect(verifier.verify(stale)).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);
  });

  it("accepts a missing typ for Keycloak compatibility but rejects a conflicting typ", async () => {
    await expect(verifier.verify(await logoutToken({}, {}))).resolves.toMatchObject({
      keycloakSid: "keycloak-session",
    });
    await expect(
      verifier.verify(await logoutToken({}, { typ: "JWT" })),
    ).rejects.toBeInstanceOf(InvalidBackchannelLogoutError);
  });

  it("HMAC-hashes jti and rejects replay before a second session delete", async () => {
    const repository = new MemoryLogoutRepository();
    const service = new BackchannelLogoutService(
      verifier,
      repository,
      Buffer.alloc(32, 7),
      () => now,
    );
    const token = await logoutToken();
    await expect(service.consume(token)).resolves.toMatchObject({
      accepted: true,
      deletedSessions: 2,
    });
    expect(repository.inputs[0]?.jtiHash).toHaveLength(32);
    expect(repository.inputs[0]?.jtiHash.toString("utf8")).not.toContain("logout-jti-0001");
    await expect(service.consume(token)).rejects.toBeInstanceOf(BackchannelLogoutReplayError);
    expect(repository.inputs).toHaveLength(1);
  });
});
