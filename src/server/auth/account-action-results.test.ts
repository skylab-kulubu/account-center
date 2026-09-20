// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AccountActionResultStore } from "@/server/auth/account-action-results";
import type { AccountActionResultRepository } from "@/server/auth/repositories";
import type { StoredAccountActionResult } from "@/server/auth/types";

class MemoryResultRepository implements AccountActionResultRepository {
  stored?: StoredAccountActionResult;
  consumed = false;

  async insert(result: StoredAccountActionResult) {
    this.stored = result;
  }

  async read(resultHash: Buffer, sessionId: string, now: Date) {
    if (
      !this.stored ||
      this.consumed ||
      !this.stored.resultHash.equals(resultHash) ||
      this.stored.sessionId !== sessionId ||
      this.stored.expiresAt <= now
    ) return null;
    return { action: this.stored.action, outcome: this.stored.outcome };
  }

  async consume(resultHash: Buffer, sessionId: string, now: Date) {
    if (
      !this.stored ||
      this.consumed ||
      !this.stored.resultHash.equals(resultHash) ||
      this.stored.sessionId !== sessionId ||
      this.stored.expiresAt <= now
    ) return null;
    this.consumed = true;
    return { action: this.stored.action, outcome: this.stored.outcome };
  }
}

describe("account action one-time results", () => {
  it("reads without consuming, then acknowledges once for the bound session", async () => {
    const repository = new MemoryResultRepository();
    const store = new AccountActionResultStore(
      repository,
      300,
      () => new Date("2026-09-20T12:00:00.000Z"),
    );
    const reference = await store.create("session-one", {
      action: "passkey",
      outcome: "success",
    });

    expect(reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.stored?.resultHash.toString("base64url")).not.toBe(reference);
    await expect(store.read(reference, "session-two")).resolves.toBeNull();
    await expect(store.read(reference, "session-one")).resolves.toEqual({
      action: "passkey",
      outcome: "success",
    });
    await expect(store.read(reference, "session-one")).resolves.toEqual({
      action: "passkey",
      outcome: "success",
    });
    await expect(store.consume(reference, "session-two")).resolves.toBeNull();
    await expect(store.consume(reference, "session-one")).resolves.toEqual({
      action: "passkey",
      outcome: "success",
    });
    await expect(store.consume(reference, "session-one")).resolves.toBeNull();
  });

  it("rejects malformed public references without touching storage", async () => {
    const repository = new MemoryResultRepository();
    const read = vi.spyOn(repository, "read");
    const consume = vi.spyOn(repository, "consume");
    const store = new AccountActionResultStore(repository);

    await expect(store.read("../not-a-result", "session-one")).resolves.toBeNull();
    await expect(store.consume("../not-a-result", "session-one")).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});
