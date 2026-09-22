import "server-only";

import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { hmacSha256 } from "@/server/auth/crypto";
import type { RateLimitRepository } from "@/server/auth/repositories";

export type AnonymousAuthRateLimitScope =
  | "login"
  | "callback"
  | "native_create"
  | "native_consume"
  | "native_redeem"
  | "sudo"
  | "sudo_options"
  | "security_mutation"
  | "totp_confirm"
  | "identity_mutation";

/**
 * `sudo`, `sudo_options`, `security_mutation`, `totp_confirm` and
 * `identity_mutation` are keyed by the local session id (`consumeKey`) and
 * mirror the sky-account budgets (10 proofs, 30 option requests, 30
 * credential mutations, 10 TOTP confirmations per fixed 15-minute window;
 * name and username changes share the SPI's 30-wide `mutation` budget with
 * the credential routes, so they get a tighter 10) so a session cannot burn
 * the person's upstream budget or the realm brute-force counter from this side.
 */
const policies: Record<AnonymousAuthRateLimitScope, { limit: number; windowSeconds: number }> = {
  login: { limit: 10, windowSeconds: 60 },
  callback: { limit: 30, windowSeconds: 60 },
  native_create: { limit: 10, windowSeconds: 60 },
  native_consume: { limit: 30, windowSeconds: 60 },
  native_redeem: { limit: 120, windowSeconds: 60 },
  sudo: { limit: 10, windowSeconds: 15 * 60 },
  sudo_options: { limit: 30, windowSeconds: 15 * 60 },
  security_mutation: { limit: 30, windowSeconds: 15 * 60 },
  totp_confirm: { limit: 10, windowSeconds: 15 * 60 },
  identity_mutation: { limit: 10, windowSeconds: 15 * 60 },
};

function canonicalIp(value: string) {
  if (value.length > 64 || value.includes(",") || value !== value.trim()) return null;
  const version = isIP(value);
  if (version === 4) return value.split(".").map((part) => String(Number(part))).join(".");
  if (version === 6) {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  }
  return null;
}

export function trustedClientAddress(request: Pick<NextRequest, "headers">, trustedProxy: "cloudflare") {
  if (trustedProxy !== "cloudflare") return "unavailable";
  const value = request.headers.get("cf-connecting-ip");
  return value ? canonicalIp(value) ?? "unavailable" : "unavailable";
}

export class AnonymousAuthRateLimiter {
  constructor(
    private readonly repository: RateLimitRepository,
    private readonly hmacKey: Buffer,
    private readonly trustedProxy: "cloudflare",
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async consume(request: Pick<NextRequest, "headers">, scope: AnonymousAuthRateLimitScope) {
    const address = trustedClientAddress(request, this.trustedProxy);
    return this.consumeKey(scope, address);
  }

  async consumeKey(scope: AnonymousAuthRateLimitScope, identity: string) {
    const now = this.clock();
    const policy = policies[scope];
    const windowMilliseconds = policy.windowSeconds * 1_000;
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds,
    );
    const windowExpiresAt = new Date(windowStartedAt.getTime() + windowMilliseconds);
    const result = await this.repository.consume({
      keyHash: hmacSha256(this.hmacKey, `rate-limit:${scope}`, identity),
      windowStartedAt,
      windowExpiresAt,
      limit: policy.limit,
    });
    return {
      ...result,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowExpiresAt.getTime() - now.getTime()) / 1_000),
      ),
    };
  }
}
