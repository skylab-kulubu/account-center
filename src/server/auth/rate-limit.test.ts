import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { AnonymousAuthRateLimiter, trustedClientAddress } from "@/server/auth/rate-limit";
import type { RateLimitInput, RateLimitRepository } from "@/server/auth/repositories";
import {
  parseTrustedProxyRanges,
  TRUSTED_PROXY_RANGE_DEFAULTS,
} from "@/server/auth/trusted-proxy";

class CapturingRateLimits implements RateLimitRepository {
  inputs: RateLimitInput[] = [];
  count = 0;

  async consume(input: RateLimitInput) {
    this.inputs.push(input);
    this.count += 1;
    return { allowed: this.count <= input.limit, count: this.count };
  }
}

function forwarded(headers: Record<string, string>) {
  return new NextRequest("https://my.yildizskylab.com/api/auth/login", { headers });
}

describe("anonymous auth rate limiting", () => {
  it("trusts only a canonical Cloudflare address and ignores spoofable forwarded headers", () => {
    const request = new NextRequest("https://my.yildizskylab.com/api/auth/login", {
      headers: {
        "cf-connecting-ip": "2001:0DB8:0:0:0:0:0:1",
        "x-forwarded-for": "198.51.100.77",
      },
    });
    expect(trustedClientAddress(request, "cloudflare")).toBe("2001:db8::1");
    expect(
      trustedClientAddress(
        new NextRequest("https://my.yildizskylab.com", {
          headers: { "x-forwarded-for": "198.51.100.77" },
        }),
        "cloudflare",
      ),
    ).toBe("unavailable");
  });

  it("reads the Traefik chain from the right and ignores a spoofed prefix", () => {
    // Traefik writes exactly one entry — the peer it saw — and discards whatever arrived.
    expect(trustedClientAddress(forwarded({ "x-forwarded-for": "203.0.113.42" }), "traefik"))
      .toBe("203.0.113.42");
    // A visitor-supplied prefix stays to the left of the address the edge observed.
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "198.51.100.77, 203.0.113.42" }),
        "traefik",
      ),
    ).toBe("203.0.113.42");
    // Internal hops appended on the right are skipped, the public client wins.
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "203.0.113.42, 10.0.1.109, 172.20.0.3" }),
        "traefik",
      ),
    ).toBe("203.0.113.42");
    // A chain of nothing but known hops keeps the closest one instead of failing closed.
    expect(
      trustedClientAddress(forwarded({ "x-forwarded-for": "10.0.0.9, 10.0.1.109" }), "traefik"),
    ).toBe("10.0.1.109");
  });

  it("normalises an IPv6 client and drops entries that are not addresses", () => {
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "2001:0DB8:0:0:0:0:0:1, 10.0.1.109" }),
        "traefik",
      ),
    ).toBe("2001:db8::1");
    // Ports, host names and `unknown` are not addresses, so only the real entry counts.
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "unknown, 203.0.113.9:443, example.com, 203.0.113.42" }),
        "traefik",
      ),
    ).toBe("203.0.113.42");
    // An IPv6 hop inside the configured ranges is skipped like any other.
    expect(
      trustedClientAddress(forwarded({ "x-forwarded-for": "2001:db8::1, fd00::9" }), "traefik"),
    ).toBe("2001:db8::1");
  });

  it("fails closed into the shared bucket when Traefik hands over nothing usable", () => {
    expect(trustedClientAddress(forwarded({}), "traefik")).toBe("unavailable");
    expect(trustedClientAddress(forwarded({ "x-forwarded-for": "unknown" }), "traefik"))
      .toBe("unavailable");
    expect(
      trustedClientAddress(forwarded({ "x-forwarded-for": "not-an-address, <script>" }), "traefik"),
    ).toBe("unavailable");
    expect(trustedClientAddress(forwarded({ "x-real-ip": "example.com" }), "traefik"))
      .toBe("unavailable");
  });

  it("accepts X-Real-IP only as the single-value fallback for an absent chain", () => {
    expect(trustedClientAddress(forwarded({ "x-real-ip": "203.0.113.42" }), "traefik"))
      .toBe("203.0.113.42");
    expect(trustedClientAddress(forwarded({ "x-real-ip": "2001:0DB8::1" }), "traefik"))
      .toBe("2001:db8::1");
    // Once Traefik wrote a chain, the chain is the only source.
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "203.0.113.42", "x-real-ip": "198.51.100.77" }),
        "traefik",
      ),
    ).toBe("203.0.113.42");
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "unknown", "x-real-ip": "198.51.100.77" }),
        "traefik",
      ),
    ).toBe("unavailable");
  });

  it("honours a narrowed trusted-proxy range set", () => {
    const ranges = parseTrustedProxyRanges("10.0.1.0/24") ?? [];
    // 192.168.1.1 is no longer a known hop, so it is taken as the client itself.
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "203.0.113.42, 192.168.1.1, 10.0.1.109" }),
        "traefik",
        ranges,
      ),
    ).toBe("192.168.1.1");
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "203.0.113.42, 10.0.1.109" }),
        "traefik",
        ranges,
      ),
    ).toBe("203.0.113.42");
  });

  it("trusts no forwarded header at all in none mode", () => {
    const request = forwarded({
      "x-forwarded-for": "198.51.100.77",
      "x-real-ip": "198.51.100.77",
      "cf-connecting-ip": "198.51.100.77",
    });
    const withSocket = (ip: string) => ({ headers: request.headers, ip });
    expect(trustedClientAddress(request, "none")).toBe("unavailable");
    // Only a socket address the runtime itself exposes counts, port or not.
    expect(trustedClientAddress(withSocket("203.0.113.42"), "none")).toBe("203.0.113.42");
    expect(trustedClientAddress(withSocket("203.0.113.42:51234"), "none")).toBe("203.0.113.42");
    expect(trustedClientAddress(withSocket("[2001:0DB8::1]:51234"), "none")).toBe("2001:db8::1");
    expect(trustedClientAddress(withSocket("not-an-address"), "none")).toBe("unavailable");
  });

  it("keeps Cloudflare mode blind to the Traefik headers", () => {
    expect(
      trustedClientAddress(
        forwarded({ "x-forwarded-for": "203.0.113.42", "x-real-ip": "203.0.113.42" }),
        "cloudflare",
      ),
    ).toBe("unavailable");
  });

  it("persists only a stable HMAC and returns an exact retry window", async () => {
    const repository = new CapturingRateLimits();
    const limiter = new AnonymousAuthRateLimiter(
      repository,
      Buffer.alloc(32, 3),
      "cloudflare",
      TRUSTED_PROXY_RANGE_DEFAULTS,
      () => new Date("2026-09-20T00:00:42Z"),
    );
    const rawIp = "203.0.113.42";
    const request = new NextRequest("https://my.yildizskylab.com/api/auth/login", {
      headers: { "cf-connecting-ip": rawIp },
    });
    const result = await limiter.consume(request, "login");

    expect(result).toMatchObject({ allowed: true, retryAfterSeconds: 18 });
    expect(repository.inputs[0]?.keyHash).toHaveLength(32);
    expect(repository.inputs[0]?.keyHash.toString("utf8")).not.toContain(rawIp);
    expect(repository.inputs[0]?.windowStartedAt).toEqual(new Date("2026-09-20T00:00:00Z"));
    expect(repository.inputs[0]?.windowExpiresAt).toEqual(new Date("2026-09-20T00:01:00Z"));
  });

  it.each([
    ["login" as const, 10],
    ["callback" as const, 30],
  ])("enforces the %s policy atomically at %d requests per minute", async (scope, limit) => {
    const repository = new CapturingRateLimits();
    const limiter = new AnonymousAuthRateLimiter(
      repository,
      Buffer.alloc(32, 3),
      "cloudflare",
      TRUSTED_PROXY_RANGE_DEFAULTS,
      () => new Date("2026-09-20T00:00:10Z"),
    );

    const results = [];
    for (let index = 0; index <= limit; index += 1) {
      results.push(await limiter.consumeKey(scope, "stable-caller"));
    }
    expect(results.filter((result) => result.allowed)).toHaveLength(limit);
    expect(results.at(-1)).toMatchObject({ allowed: false, retryAfterSeconds: 50 });
  });

  it.each([
    ["sudo" as const, 10],
    ["sudo_options" as const, 30],
    ["security_mutation" as const, 30],
    ["totp_confirm" as const, 10],
    ["identity_mutation" as const, 10],
    ["email_mutation" as const, 10],
    ["email_confirm" as const, 16],
  ])("caps %s attempts per session at %d in a fixed 15-minute window", async (scope, limit) => {
    const repository = new CapturingRateLimits();
    const limiter = new AnonymousAuthRateLimiter(
      repository,
      Buffer.alloc(32, 3),
      "cloudflare",
      TRUSTED_PROXY_RANGE_DEFAULTS,
      () => new Date("2026-09-20T00:07:30Z"),
    );
    const sessionId = "11111111-1111-4111-8111-111111111111";

    const results = [];
    for (let index = 0; index <= limit; index += 1) {
      results.push(await limiter.consumeKey(scope, sessionId));
    }
    expect(results.filter((result) => result.allowed)).toHaveLength(limit);
    expect(results.at(-1)).toMatchObject({ allowed: false, retryAfterSeconds: 450 });
    expect(repository.inputs[0]?.windowStartedAt).toEqual(new Date("2026-09-20T00:00:00Z"));
    expect(repository.inputs[0]?.windowExpiresAt).toEqual(new Date("2026-09-20T00:15:00Z"));
    expect(repository.inputs[0]?.keyHash.toString("utf8")).not.toContain(sessionId);
    await limiter.consumeKey(scope, "22222222-2222-4222-8222-222222222222");
    expect(repository.inputs.at(-1)?.keyHash.equals(repository.inputs[0]!.keyHash)).toBe(false);
  });
});
