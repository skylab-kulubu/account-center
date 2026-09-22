import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as loginRoute } from "@/app/api/auth/login/route";
import { AnonymousAuthRateLimiter } from "@/server/auth/rate-limit";
import type { RateLimitInput, RateLimitRepository } from "@/server/auth/repositories";
import { TRUSTED_PROXY_RANGE_DEFAULTS } from "@/server/auth/trusted-proxy";
import type { AuthTrustedProxy } from "@/server/auth/trusted-proxy";

vi.mock("@/server/auth/logging", () => ({
  logAuthEvent: vi.fn(),
  requestCorrelationId: () => "request-id",
}));

vi.mock("@/server/auth/services", () => ({ getAuthServices: () => services }));

/** The same fixed-window bookkeeping the PostgreSQL repository performs, kept in memory. */
class InMemoryRateLimits implements RateLimitRepository {
  private readonly counts = new Map<string, number>();

  async consume({ keyHash, windowStartedAt, limit }: RateLimitInput) {
    const bucket = `${keyHash.toString("hex")}:${windowStartedAt.toISOString()}`;
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);
    return { allowed: count <= limit, count };
  }

  get bucketCount() {
    return this.counts.size;
  }
}

let services: {
  config: { appUrl: URL };
  oidc: { begin: () => Promise<{ authorizationUrl: URL; browserBinding: string }> };
  anonymousRateLimit: AnonymousAuthRateLimiter;
};
let repository: InMemoryRateLimits;

function mount(trustedProxy: AuthTrustedProxy) {
  repository = new InMemoryRateLimits();
  services = {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    oidc: {
      begin: async () => ({
        authorizationUrl: new URL(
          "https://e.yildizskylab.com/realms/e-skylab/protocol/openid-connect/auth?request_uri=urn%3Apar%3A1",
        ),
        browserBinding: "b".repeat(43),
      }),
    },
    anonymousRateLimit: new AnonymousAuthRateLimiter(
      repository,
      Buffer.alloc(32, 7),
      trustedProxy,
      TRUSTED_PROXY_RANGE_DEFAULTS,
      () => new Date("2026-09-20T00:00:10Z"),
    ),
  };
}

/** One anonymous login as Traefik forwards it: the visitor, then the proxy hop. */
function login(forwardedFor: string) {
  return loginRoute(
    new NextRequest("https://my.yildizskylab.com/api/auth/login", {
      headers: { "x-forwarded-for": forwardedFor },
    }),
  );
}

async function drainLoginBudget(forwardedFor: string) {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    statuses.push((await login(forwardedFor)).status);
  }
  return statuses;
}

describe("anonymous login rate limiting through the route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives every client address its own login budget in traefik mode", async () => {
    mount("traefik");
    const visitor = "203.0.113.42, 10.0.1.109";
    const neighbour = "198.51.100.77, 10.0.1.109";

    expect(await drainLoginBudget(visitor)).toEqual(Array<number>(10).fill(303));

    const exhausted = await login(visitor);
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get("retry-after")).toBe("50");

    // A different visitor is untouched by the first one's exhausted budget.
    const independent = await login(neighbour);
    expect(independent.status).toBe(303);
    expect(independent.headers.get("location")).toContain("e.yildizskylab.com");

    // A spoofed prefix cannot charge somebody else's bucket either.
    const spoofed = await login(`203.0.113.42, ${neighbour}`);
    expect(spoofed.status).toBe(303);
    expect(repository.bucketCount).toBe(2);
  });

  it("shares one global budget across every visitor when no client address is readable", async () => {
    mount("cloudflare");
    expect(await drainLoginBudget("203.0.113.42, 10.0.1.109")).toEqual(Array<number>(10).fill(303));

    // Cloudflare is not in front, so both visitors fall into the shared fail-closed bucket.
    expect((await login("198.51.100.77, 10.0.1.109")).status).toBe(429);
    expect(repository.bucketCount).toBe(1);
  });
});
