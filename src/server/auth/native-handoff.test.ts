// @vitest-environment node

import { describe, expect, it } from "vitest";
import { sha256 } from "@/server/auth/crypto";
import {
  InvalidNativeHandoffError,
  NativeHandoffService,
} from "@/server/auth/native-handoff";
import type {
  ConsumeNativeHandoffInput,
  NativeHandoffRepository,
} from "@/server/auth/repositories";
import type { NativeHandoffIdentity, NewNativeHandoff } from "@/server/auth/types";

const now = new Date("2026-09-20T12:00:00Z");
const identity = {
  subject: "user-id",
  keycloakSid: "native-session",
  authenticatedAt: new Date("2026-09-20T11:45:00Z"),
  expiresAt: new Date("2026-09-20T12:05:00Z"),
};

class MemoryNativeHandoffs implements NativeHandoffRepository {
  inserted?: NewNativeHandoff;
  consumed = false;
  consumeInput?: ConsumeNativeHandoffInput;

  async insert(handoff: NewNativeHandoff) {
    this.inserted = handoff;
  }

  async consumeAndCreateBridge(input: ConsumeNativeHandoffInput): Promise<NativeHandoffIdentity | null> {
    this.consumeInput = input;
    if (this.consumed || !this.inserted?.codeHash.equals(input.publicCodeHash)) return null;
    this.consumed = true;
    return {
      subject: this.inserted.subject,
      keycloakSid: this.inserted.keycloakSid,
      authenticatedAt: this.inserted.authenticatedAt,
    };
  }

  async redeemBridge() {
    return null;
  }
}

function fixture(options: { expiresAt?: Date } = {}) {
  const repository = new MemoryNativeHandoffs();
  const verifier = {
    verify: async (token: string) => {
      if (token !== "valid-native-token") throw new Error("invalid token");
      return { ...identity, expiresAt: options.expiresAt ?? identity.expiresAt };
    },
  };
  const starts: Array<{ identity: NativeHandoffIdentity; bridgeCode: string }> = [];
  const oidc = {
    beginNative: async (value: NativeHandoffIdentity, bridgeCode: string) => {
      starts.push({ identity: value, bridgeCode });
      return {
        authorizationUrl: new URL("https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Apar%3A1"),
        browserBinding: "browser-binding",
      };
    },
  };
  const randomValues = ["p".repeat(43), "b".repeat(43)];
  const service = new NativeHandoffService(
    verifier,
    repository,
    oidc,
    new URL("https://my.yildizskylab.com"),
    () => now,
    () => randomValues.shift() ?? "z".repeat(43),
  );
  return { service, repository, starts };
}

describe("NativeHandoffService", () => {
  it("creates a 45-second public handoff and stores only its SHA-256 hash", async () => {
    const { service, repository } = fixture();

    await expect(service.create("valid-native-token")).resolves.toEqual({
      handoffUrl: `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}`,
      expiresIn: 45,
    });
    expect(repository.inserted).toMatchObject({
      subject: "user-id",
      keycloakSid: "native-session",
      authenticatedAt: identity.authenticatedAt,
      createdAt: now,
      expiresAt: new Date("2026-09-20T12:00:45Z"),
      codeHash: sha256("p".repeat(43)),
    });
    expect(JSON.stringify(repository.inserted)).not.toContain("p".repeat(43));
  });

  it("never lets the handoff outlive the verified bearer token", async () => {
    const { service, repository } = fixture({
      expiresAt: new Date("2026-09-20T12:00:12Z"),
    });

    await expect(service.create("valid-native-token")).resolves.toMatchObject({ expiresIn: 12 });
    expect(repository.inserted?.expiresAt).toEqual(new Date("2026-09-20T12:00:12Z"));
  });

  it("atomically exchanges the public code for a distinct bridge hint exactly once", async () => {
    const { service, repository, starts } = fixture();
    await service.create("valid-native-token");

    const authorization = await service.consume("p".repeat(43));

    expect(repository.consumeInput).toMatchObject({
      publicCodeHash: sha256("p".repeat(43)),
      bridgeCodeHash: sha256("b".repeat(43)),
      now,
      bridgeExpiresAt: new Date("2026-09-20T12:00:45Z"),
    });
    expect(starts).toEqual([{
      identity: {
        subject: "user-id",
        keycloakSid: "native-session",
        authenticatedAt: identity.authenticatedAt,
      },
      bridgeCode: "b".repeat(43),
    }]);
    expect(authorization.authorizationUrl.searchParams.get("request_uri")).toBe("urn:par:1");
    await expect(service.consume("p".repeat(43))).rejects.toBeInstanceOf(
      InvalidNativeHandoffError,
    );
    expect(starts).toHaveLength(1);
  });

  it("rejects malformed public codes without touching persistence", async () => {
    const { service, repository } = fixture();

    await expect(service.consume("short")).rejects.toBeInstanceOf(InvalidNativeHandoffError);
    expect(repository.consumeInput).toBeUndefined();
  });
});
