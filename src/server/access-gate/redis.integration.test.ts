// @vitest-environment node

import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_ACCESS_CONTRACT_KEY,
  ACCOUNT_ACCESS_CONTRACT_VALUE,
  ACCOUNT_ACCESS_ISSUER,
  accountAccessMarkerKey,
} from "@/server/access-gate/contract";
import { createAccountAccessGate, RedisAccountAccessGate } from "@/server/access-gate/gate";

const redisUrl = process.env.TEST_ACCOUNT_ACCESS_REDIS_URL;
const redisDescribe = redisUrl ? describe : describe.skip;
const integrationUrl = redisUrl ?? "redis://default:unused@127.0.0.1:1/15";
const subject = "11111111-1111-1111-1111-111111111111";
const markerKey = accountAccessMarkerKey(ACCOUNT_ACCESS_ISSUER, subject);

redisDescribe("Redis account access contract", () => {
  const parsed = new URL(integrationUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || parsed.pathname !== "/15") {
    throw new Error("Redis integration tests require loopback database 15.");
  }
  const redis = new Redis(integrationUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  const gate = new RedisAccountAccessGate(redis);

  beforeAll(async () => {
    await redis.connect();
  });

  beforeEach(async () => {
    await redis.del(markerKey, ACCOUNT_ACCESS_CONTRACT_KEY);
    await redis.set(ACCOUNT_ACCESS_CONTRACT_KEY, ACCOUNT_ACCESS_CONTRACT_VALUE);
  });

  afterAll(async () => {
    await redis.del(markerKey, ACCOUNT_ACCESS_CONTRACT_KEY);
    await redis.quit();
  });

  it("allows an absent marker and denies the permanent golden-vector marker", async () => {
    await expect(gate.decide(subject)).resolves.toBe("active");
    await redis.set(markerKey, "1");

    await expect(gate.decide(subject)).resolves.toBe("blocked");
    await expect(redis.pttl(markerKey)).resolves.toBe(-1);
  });

  it("fails closed for a malformed marker or contract", async () => {
    await redis.set(markerKey, "unexpected");
    await expect(gate.decide(subject)).resolves.toBe("unavailable");

    await redis.set(markerKey, "1");
    await redis.set(ACCOUNT_ACCESS_CONTRACT_KEY, "wrong-contract");
    await expect(gate.decide(subject)).resolves.toBe("unavailable");
    await expect(gate.ready()).resolves.toBe(false);
  });

  it("bounds connection failure and fails closed", async () => {
    const unavailable = createAccountAccessGate({
      mode: "enforce",
      host: "127.0.0.1",
      port: 1,
      username: "default",
      password: "not-used",
      database: 15,
      tls: false,
      operationTimeoutMs: 50,
    });
    const startedAt = Date.now();

    await expect(unavailable.decide(subject)).resolves.toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
