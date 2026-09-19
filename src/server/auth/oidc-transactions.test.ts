import { describe, expect, it } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import type { OidcTransactionRepository } from "@/server/auth/repositories";
import type { StoredOidcTransaction } from "@/server/auth/types";
import { OidcTransactionStore } from "@/server/auth/oidc-transactions";

class MemoryTransactions implements OidcTransactionRepository {
  readonly rows = new Map<string, StoredOidcTransaction & { consumedAt?: Date }>();

  async insert(value: StoredOidcTransaction) {
    this.rows.set(value.stateHash.toString("hex"), value);
  }

  async consume(stateHash: Buffer, browserBindingHash: Buffer, now: Date) {
    const row = this.rows.get(stateHash.toString("hex"));
    if (
      !row ||
      !row.browserBindingHash.equals(browserBindingHash) ||
      row.consumedAt ||
      row.expiresAt <= now
    ) return null;
    row.consumedAt = now;
    return { id: row.id, payloadCiphertext: row.payloadCiphertext };
  }
}

describe("OidcTransactionStore", () => {
  it("stores encrypted context and consumes state exactly once", async () => {
    const repository = new MemoryTransactions();
    const store = new OidcTransactionStore(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 3)),
      300,
      () => new Date("2026-09-20T00:00:00Z"),
    );
    const payload = {
      state: "s".repeat(43),
      nonce: "n".repeat(43),
      codeVerifier: "v".repeat(43),
      returnTo: "/security",
    };

    const browserBinding = "b".repeat(43);
    await store.create(payload, browserBinding);
    const stored = [...repository.rows.values()][0];
    expect(stored?.payloadCiphertext).not.toContain(payload.nonce);
    await expect(store.consume(payload.state, "a".repeat(43))).resolves.toBeNull();
    await expect(store.consume(payload.state, browserBinding)).resolves.toEqual(payload);
    await expect(store.consume(payload.state, browserBinding)).resolves.toBeNull();
    await expect(store.consume("x".repeat(43), browserBinding)).resolves.toBeNull();
  });

  it("rejects expired transactions", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const store = new OidcTransactionStore(
      new MemoryTransactions(),
      new AesGcmSecretCipher(Buffer.alloc(32, 4)),
      1,
      () => now,
    );
    const state = "s".repeat(43);
    const browserBinding = "b".repeat(43);
    await store.create({ state, nonce: "n".repeat(43), codeVerifier: "v".repeat(43), returnTo: "/" }, browserBinding);
    now = new Date("2026-09-20T00:00:02Z");
    await expect(store.consume(state, browserBinding)).resolves.toBeNull();
  });
});
