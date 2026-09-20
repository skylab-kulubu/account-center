import "server-only";

import { randomUUID } from "node:crypto";
import { randomOpaqueValue, sha256 } from "@/server/auth/crypto";
import type { NativeHandoffRepository } from "@/server/auth/repositories";
import type { NativeHandoffIdentity } from "@/server/auth/types";
import type { VerifiedNativeIdentity } from "@/server/auth/native-handoff-token";
import type { AccountAccessAuthorizer } from "@/server/access-gate/authorization";

const handoffTtlMilliseconds = 45_000;
const opaqueCodePattern = /^[A-Za-z0-9_-]{43}$/;

type NativeTokenVerifier = {
  verify(token: string): Promise<VerifiedNativeIdentity>;
};

type NativeOidcStarter = {
  beginNative(identity: NativeHandoffIdentity, bridgeCode: string): Promise<{
    authorizationUrl: URL;
    browserBinding: string;
  }>;
};

export class InvalidNativeHandoffError extends Error {
  constructor() {
    super("The native handoff is invalid, expired, or already used.");
    this.name = "InvalidNativeHandoffError";
  }
}

export class NativeHandoffService {
  constructor(
    private readonly verifier: NativeTokenVerifier,
    private readonly repository: NativeHandoffRepository,
    private readonly oidc: NativeOidcStarter,
    private readonly accountAccess: AccountAccessAuthorizer,
    private readonly appUrl: URL,
    private readonly clock: () => Date = () => new Date(),
    private readonly randomCode: () => string = () => randomOpaqueValue(),
  ) {}

  async create(token: string) {
    const identity = await this.verifier.verify(token);
    const now = this.clock();
    const expiresAt = new Date(Math.min(
      now.getTime() + handoffTtlMilliseconds,
      identity.expiresAt.getTime(),
    ));
    if (expiresAt <= now) throw new InvalidNativeHandoffError();
    await this.accountAccess.requireActive(identity.subject);

    const code = this.randomCode();
    if (!opaqueCodePattern.test(code)) throw new Error("Native handoff code generator failed.");
    await this.repository.insert({
      id: randomUUID(),
      codeHash: sha256(code),
      subject: identity.subject,
      keycloakSid: identity.keycloakSid,
      authenticatedAt: identity.authenticatedAt,
      createdAt: now,
      expiresAt,
    });

    const url = new URL("/handoff", this.appUrl);
    url.searchParams.set("code", code);
    return {
      handoffUrl: url.href,
      expiresIn: Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000)),
    };
  }

  async consume(publicCode: string) {
    if (!opaqueCodePattern.test(publicCode)) throw new InvalidNativeHandoffError();
    const bridgeCode = this.randomCode();
    if (!opaqueCodePattern.test(bridgeCode)) throw new Error("Native bridge code generator failed.");
    const now = this.clock();
    const candidate = await this.repository.findActiveHandoff(sha256(publicCode), now);
    if (!candidate) throw new InvalidNativeHandoffError();
    await this.accountAccess.requireActive(candidate.subject);
    const identity = await this.repository.consumeAndCreateBridge({
      publicCodeHash: sha256(publicCode),
      bridgeId: randomUUID(),
      bridgeCodeHash: sha256(bridgeCode),
      now,
      bridgeExpiresAt: new Date(now.getTime() + handoffTtlMilliseconds),
    });
    if (!identity) throw new InvalidNativeHandoffError();
    return this.oidc.beginNative(identity, bridgeCode);
  }

  async redeem(
    bridgeCode: string,
    proof: { requestNonceHash: Buffer; requestNonceExpiresAt: Date },
  ) {
    if (!opaqueCodePattern.test(bridgeCode)) throw new InvalidNativeHandoffError();
    const bridgeCodeHash = sha256(bridgeCode);
    const now = this.clock();
    const candidate = await this.repository.findActiveBridge(bridgeCodeHash, now);
    if (!candidate) throw new InvalidNativeHandoffError();
    await this.accountAccess.requireActive(candidate.subject);
    const result = await this.repository.redeemBridge({
      bridgeCodeHash,
      requestNonceHash: proof.requestNonceHash,
      requestNonceExpiresAt: proof.requestNonceExpiresAt,
      now,
    });
    if (!result) throw new InvalidNativeHandoffError();
    return result;
  }
}
