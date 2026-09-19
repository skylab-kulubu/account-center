import "server-only";

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

export type VerifiedNativeIdentity = {
  subject: string;
  keycloakSid: string;
  authenticatedAt: Date;
  expiresAt: Date;
};

export class InvalidNativeAccessTokenError extends Error {
  constructor() {
    super("The native access token is invalid.");
    this.name = "InvalidNativeAccessTokenError";
  }
}

function exactStringClaim(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);
}

export class NativeAccessTokenVerifier {
  constructor(
    private readonly issuer: URL,
    private readonly verificationKey: JWTVerifyGetKey,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async verify(token: string): Promise<VerifiedNativeIdentity> {
    if (token.length < 64 || token.length > 16_384 || /\s/.test(token)) {
      throw new InvalidNativeAccessTokenError();
    }

    try {
      const now = this.clock();
      const result = await jwtVerify(token, this.verificationKey, {
        algorithms: ["RS256"],
        issuer: this.issuer.href.replace(/\/$/, ""),
        audience: "account-center",
        currentDate: now,
        requiredClaims: ["exp", "sub", "sid", "auth_time", "azp"],
      });
      const { payload } = result;
      const authTime = payload.auth_time;
      if (
        payload.azp !== "skyapp" ||
        !exactStringClaim(payload.sub) ||
        !exactStringClaim(payload.sid) ||
        typeof authTime !== "number" ||
        !Number.isSafeInteger(authTime) ||
        authTime < 0 ||
        authTime > Math.floor(now.getTime() / 1_000) ||
        typeof payload.exp !== "number" ||
        !Number.isSafeInteger(payload.exp)
      ) {
        throw new InvalidNativeAccessTokenError();
      }
      return {
        subject: payload.sub,
        keycloakSid: payload.sid,
        authenticatedAt: new Date(authTime * 1_000),
        expiresAt: new Date(payload.exp * 1_000),
      };
    } catch {
      throw new InvalidNativeAccessTokenError();
    }
  }
}

export function createNativeAccessTokenVerifier(issuer: URL) {
  const realm = issuer.href.replace(/\/$/, "");
  const jwksUrl = new URL(`${realm}/protocol/openid-connect/certs`);
  return new NativeAccessTokenVerifier(
    issuer,
    createRemoteJWKSet(jwksUrl, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 5 * 60 * 1_000,
    }),
  );
}
