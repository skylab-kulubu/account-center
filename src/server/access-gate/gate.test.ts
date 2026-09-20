// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_ACCESS_CONTRACT_KEY,
  ACCOUNT_ACCESS_CONTRACT_VALUE,
  ACCOUNT_ACCESS_ISSUER,
  accountAccessMarkerKey,
} from "@/server/access-gate/contract";
import { RedisAccountAccessGate } from "@/server/access-gate/gate";

describe("RedisAccountAccessGate", () => {
  it.each([
    { values: [ACCOUNT_ACCESS_CONTRACT_VALUE, null], outcome: "active" },
    { values: [ACCOUNT_ACCESS_CONTRACT_VALUE, "1"], outcome: "blocked" },
    { values: [null, null], outcome: "unavailable" },
    { values: ["wrong-contract", null], outcome: "unavailable" },
    { values: [ACCOUNT_ACCESS_CONTRACT_VALUE, "unexpected"], outcome: "unavailable" },
  ] as const)("returns $outcome for the exact two-key read", async ({ values, outcome }) => {
    const redis = {
      mget: vi.fn().mockResolvedValue(values),
      get: vi.fn(),
    };
    const gate = new RedisAccountAccessGate(redis);

    await expect(gate.decide("subject-value-must-not-be-a-key")).resolves.toBe(outcome);
    expect(redis.mget).toHaveBeenCalledOnce();
    expect(redis.mget).toHaveBeenCalledWith(
      ACCOUNT_ACCESS_CONTRACT_KEY,
      accountAccessMarkerKey(ACCOUNT_ACCESS_ISSUER, "subject-value-must-not-be-a-key"),
    );
    expect(JSON.stringify(redis.mget.mock.calls)).not.toContain("subject-value-must-not-be-a-key");
  });

  it("fails closed on command errors and requires the exact readiness contract", async () => {
    const redis = {
      mget: vi.fn().mockRejectedValue(new Error("connection unavailable")),
      get: vi.fn()
        .mockResolvedValueOnce(ACCOUNT_ACCESS_CONTRACT_VALUE)
        .mockResolvedValueOnce("wrong-contract")
        .mockRejectedValueOnce(new Error("connection unavailable")),
    };
    const gate = new RedisAccountAccessGate(redis);

    await expect(gate.decide("subject")).resolves.toBe("unavailable");
    await expect(gate.ready()).resolves.toBe(true);
    await expect(gate.ready()).resolves.toBe(false);
    await expect(gate.ready()).resolves.toBe(false);
  });
});
