import "server-only";

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { AuthConfig } from "@/server/auth/config";
import { hmacSha256 } from "@/server/auth/crypto";
import type { BackchannelLogoutRepository } from "@/server/auth/repositories";

const backchannelLogoutEvent = "http://schemas.openid.net/event/backchannel-logout";

export type VerifiedBackchannelLogout = {
  jti: string;
  issuedAt: number;
  keycloakSid?: string;
  subject?: string;
};

export interface BackchannelLogoutVerifier {
  verify(token: string): Promise<VerifiedBackchannelLogout>;
}

export class InvalidBackchannelLogoutError extends Error {
  constructor() {
    super("Invalid backchannel logout token.");
    this.name = "InvalidBackchannelLogoutError";
  }
}

export class BackchannelLogoutReplayError extends Error {
  constructor() {
    super("Backchannel logout token was already consumed.");
    this.name = "BackchannelLogoutReplayError";
  }
}

export class KeycloakBackchannelLogoutVerifier implements BackchannelLogoutVerifier {
  readonly #key: JWTVerifyGetKey;

  constructor(
    private readonly config: Pick<AuthConfig, "issuer" | "clientId">,
    key?: JWTVerifyGetKey,
    private readonly clock: () => Date = () => new Date(),
  ) {
    const jwksUrl = new URL(
      `${config.issuer.pathname.replace(/\/$/, "")}/protocol/openid-connect/certs`,
      config.issuer.origin,
    );
    this.#key = key ?? createRemoteJWKSet(jwksUrl, { timeoutDuration: 5_000 });
  }

  async verify(token: string): Promise<VerifiedBackchannelLogout> {
    if (token.length < 64 || token.length > 16_384) throw new InvalidBackchannelLogoutError();
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.#key, {
        algorithms: ["RS256"],
        issuer: this.config.issuer.href.replace(/\/$/, ""),
        audience: this.config.clientId,
        requiredClaims: ["iat", "jti", "events"],
        maxTokenAge: 5 * 60,
        clockTolerance: 5,
        currentDate: this.clock(),
      });
      const event = payload.events;
      const eventValue =
        typeof event === "object" && event !== null && !Array.isArray(event)
          ? (event as Record<string, unknown>)[backchannelLogoutEvent]
          : undefined;
      const validEvent =
        typeof event === "object" &&
        event !== null &&
        !Array.isArray(event) &&
        backchannelLogoutEvent in event &&
        typeof eventValue === "object" &&
        eventValue !== null &&
        !Array.isArray(eventValue) &&
        Object.keys(eventValue).length === 0;
      if (
        (protectedHeader.typ !== undefined && protectedHeader.typ !== "logout+jwt") ||
        !validEvent ||
        payload.nonce !== undefined ||
        typeof payload.iat !== "number" ||
        typeof payload.jti !== "string" ||
        payload.jti.length < 8 ||
        payload.jti.length > 512 ||
        (typeof payload.sid !== "string" && typeof payload.sub !== "string") ||
        (typeof payload.sid === "string" && (payload.sid.length < 1 || payload.sid.length > 255)) ||
        (typeof payload.sub === "string" && (payload.sub.length < 1 || payload.sub.length > 255))
      ) {
        throw new InvalidBackchannelLogoutError();
      }
      return {
        jti: payload.jti,
        issuedAt: payload.iat,
        ...(typeof payload.sid === "string" ? { keycloakSid: payload.sid } : {}),
        ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}),
      };
    } catch (error) {
      if (error instanceof InvalidBackchannelLogoutError) throw error;
      throw new InvalidBackchannelLogoutError();
    }
  }
}

export class BackchannelLogoutService {
  constructor(
    private readonly verifier: BackchannelLogoutVerifier,
    private readonly repository: BackchannelLogoutRepository,
    private readonly hmacKey: Buffer,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async consume(token: string) {
    const verified = await this.verifier.verify(token);
    const now = this.clock();
    const result = await this.repository.consumeAndDeleteSessions({
      jtiHash: hmacSha256(this.hmacKey, "backchannel-logout-jti", verified.jti),
      seenAt: now,
      replayExpiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
      keycloakSid: verified.keycloakSid,
      subject: verified.subject,
    });
    if (!result.accepted) throw new BackchannelLogoutReplayError();
    return result;
  }
}
