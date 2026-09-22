import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { AnonymousAuthRateLimiter, trustedClientAddress } from "@/server/auth/rate-limit";
import type { RateLimitInput, RateLimitRepository } from "@/server/auth/repositories";

class CapturingRateLimits implements RateLimitRepository {
  inputs: RateLimitInput[] = [];
  count = 0;

  async consume(input: RateLimitInput) {
    this.inputs.push(input);
    this.count += 1;
    return { allowed: this.count <= input.limit, count: this.count };
  }
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

  it("persists only a stable HMAC and returns an exact retry window", async () => {
    const repository = new CapturingRateLimits();
    const limiter = new AnonymousAuthRateLimiter(
      repository,
      Buffer.alloc(32, 3),
      "cloudflare",
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
    ["native_create" as const, 10],
    ["native_consume" as const, 30],
    ["native_redeem" as const, 120],
  ])("enforces the %s native policy atomically at %d requests per minute", async (scope, limit) => {
    const repository = new CapturingRateLimits();
    const limiter = new AnonymousAuthRateLimiter(
      repository,
      Buffer.alloc(32, 3),
      "cloudflare",
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
  ])("caps %s attempts per session at %d in a fixed 15-minute window", async (scope, limit) => {
    const repository = new CapturingRateLimits();
    const limiter = new AnonymousAuthRateLimiter(
      repository,
      Buffer.alloc(32, 3),
      "cloudflare",
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
