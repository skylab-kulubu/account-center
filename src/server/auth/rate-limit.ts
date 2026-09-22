import "server-only";

import type { NextRequest } from "next/server";
import { hmacSha256 } from "@/server/auth/crypto";
import type { RateLimitRepository } from "@/server/auth/repositories";
import {
  canonicalIp,
  isTrustedProxyAddress,
  TRUSTED_PROXY_RANGE_DEFAULTS,
} from "@/server/auth/trusted-proxy";
import type { AuthTrustedProxy, TrustedProxyRange } from "@/server/auth/trusted-proxy";

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

/**
 * The shared fail-closed bucket. Every request whose client address cannot be
 * established lands here together, so a missing or unreadable edge header can
 * never mint a fresh budget for an attacker.
 */
const UNAVAILABLE = "unavailable";

/**
 * What address resolution needs from a request: the headers, plus the socket
 * peer when the runtime exposes one. Next.js's Node server does not expose it,
 * so `none` mode degrades to the shared fail-closed bucket there.
 */
export type ClientAddressRequest = Pick<NextRequest, "headers"> & { readonly ip?: string };

/** A socket address as a runtime might hand it over: bare, or with a port attached. */
function socketAddress(value: string | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(trimmed);
  if (bracketed?.[1]) return canonicalIp(bracketed[1]);
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(trimmed);
  if (ipv4WithPort?.[1]) return canonicalIp(ipv4WithPort[1]);
  return canonicalIp(trimmed);
}

/**
 * `X-Forwarded-For` as a proxy that owns the header writes it: the visitor
 * first, every hop it passed appended on the right. The rightmost entry we do
 * not recognise as one of our own hops is the closest address the trusted edge
 * actually observed, so a visitor-supplied prefix on the left can never win.
 * When every entry is a known hop the rightmost one is kept — the peer itself
 * is then the most specific identity available.
 */
function forwardedClientAddress(
  request: ClientAddressRequest,
  trustedProxyRanges: readonly TrustedProxyRange[],
) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor === null) {
    const realIp = request.headers.get("x-real-ip");
    return (realIp === null ? null : canonicalIp(realIp)) ?? UNAVAILABLE;
  }
  const entries = forwardedFor
    .split(",")
    .map((entry) => canonicalIp(entry.trim()))
    .filter((entry): entry is string => entry !== null);
  if (entries.length === 0) return UNAVAILABLE;
  const client = entries.findLast((entry) => !isTrustedProxyAddress(entry, trustedProxyRanges));
  return client ?? entries[entries.length - 1] ?? UNAVAILABLE;
}

/**
 * The visitor identity this deployment is willing to stand behind, or the
 * shared `unavailable` bucket. The value is a bucket name only: it is HMAC'd
 * with a server secret before it is stored and never logged in the clear.
 */
export function trustedClientAddress(
  request: ClientAddressRequest,
  trustedProxy: AuthTrustedProxy,
  trustedProxyRanges: readonly TrustedProxyRange[] = TRUSTED_PROXY_RANGE_DEFAULTS,
) {
  if (trustedProxy === "cloudflare") {
    const value = request.headers.get("cf-connecting-ip");
    return value ? canonicalIp(value) ?? UNAVAILABLE : UNAVAILABLE;
  }
  if (trustedProxy === "traefik") return forwardedClientAddress(request, trustedProxyRanges);
  return socketAddress(request.ip) ?? UNAVAILABLE;
}

export class AnonymousAuthRateLimiter {
  constructor(
    private readonly repository: RateLimitRepository,
    private readonly hmacKey: Buffer,
    private readonly trustedProxy: AuthTrustedProxy,
    private readonly trustedProxyRanges: readonly TrustedProxyRange[] = TRUSTED_PROXY_RANGE_DEFAULTS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async consume(request: ClientAddressRequest, scope: AnonymousAuthRateLimitScope) {
    const address = trustedClientAddress(request, this.trustedProxy, this.trustedProxyRanges);
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
