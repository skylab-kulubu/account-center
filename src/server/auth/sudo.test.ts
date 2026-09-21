// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import type { StoredSudo, SudoRepository } from "@/server/auth/repositories";
import {
  SUDO_MAX_LIFETIME_SECONDS,
  SudoRequiredError,
  SudoSessionInactiveError,
  SudoVault,
} from "@/server/auth/sudo";

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-09-21T13:10:18.000Z");
const sudoToken = "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyJ9.signature-fixture";

class MemorySudo implements SudoRepository {
  entries = new Map<string, StoredSudo>();
  active = new Set<string>([sessionId, otherSessionId]);
  writes = 0;
  clears = 0;

  async replaceSudo(id: string, ciphertext: string, expiresAt: Date) {
    this.writes += 1;
    if (!this.active.has(id)) return false;
    this.entries.set(id, { ciphertext, expiresAt });
    return true;
  }

  async readSudo(id: string) {
    if (!this.active.has(id)) return null;
    return this.entries.get(id) ?? null;
  }

  async clearSudo(id: string) {
    this.clears += 1;
    this.entries.delete(id);
  }
}

function fixture(clock: () => Date = () => now) {
  const repository = new MemorySudo();
  const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 9));
  return { repository, cipher, vault: new SudoVault(repository, cipher, clock) };
}

describe("SudoVault", () => {
  it("stores the sudo token encrypted with session-bound associated data", async () => {
    const { vault, repository, cipher } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));

    const stored = repository.entries.get(sessionId);
    expect(stored?.expiresAt).toEqual(new Date("2026-09-21T13:15:18.000Z"));
    expect(typeof stored?.ciphertext).toBe("string");
    expect(stored?.ciphertext).not.toContain(sudoToken);
    expect(JSON.parse(stored!.ciphertext)).toMatchObject({ v: 1 });
    expect(cipher.decrypt(stored!.ciphertext, `session:${sessionId}:sudo`)).toEqual({ sudoToken });
    expect(() => cipher.decrypt(stored!.ciphertext, `session:${sessionId}`)).toThrow();
    expect(() => cipher.decrypt(stored!.ciphertext, `session:${otherSessionId}:sudo`)).toThrow();
  });

  it("returns the plaintext token while the sudo is fresh", async () => {
    const { vault } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    await expect(vault.requireFreshSudo(sessionId)).resolves.toBe(sudoToken);
  });

  it("does not hand a token from one session record to another", async () => {
    const { vault, repository } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    repository.entries.set(otherSessionId, repository.entries.get(sessionId)!);

    const rejection = vault.requireFreshSudo(otherSessionId);
    await expect(rejection).rejects.toBeInstanceOf(SudoRequiredError);
    await expect(rejection).rejects.toMatchObject({ reason: "missing" });
    expect(repository.entries.has(otherSessionId)).toBe(false);
    expect(repository.entries.has(sessionId)).toBe(true);
  });

  it("refuses a missing sudo with the available-methods hint", async () => {
    const { vault } = fixture();
    const rejection = vault.requireFreshSudo(sessionId, { availableMethods: ["password", "totp"] });
    await expect(rejection).rejects.toBeInstanceOf(SudoRequiredError);
    await expect(rejection).rejects.toMatchObject({
      reason: "missing",
      availableMethods: ["password", "totp"],
    });
    await expect(vault.requireFreshSudo(sessionId, { availableMethods: ["passkey"] }))
      .rejects.toMatchObject({ reason: "missing", availableMethods: ["passkey"] });
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({
      reason: "missing",
      availableMethods: null,
    });
    await expect(vault.requireFreshSudo("not-a-session-id")).rejects.toMatchObject({ reason: "missing" });
  });

  it("refuses and scrubs an expired or nearly expired sudo", async () => {
    let current = now;
    const { vault, repository } = fixture(() => current);
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));

    current = new Date("2026-09-21T13:15:14.000Z");
    const nearlyExpired = vault.requireFreshSudo(sessionId);
    await expect(nearlyExpired).rejects.toBeInstanceOf(SudoRequiredError);
    await expect(nearlyExpired).rejects.toMatchObject({ reason: "expired" });
    expect(repository.entries.has(sessionId)).toBe(false);

    current = now;
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    current = new Date("2026-09-21T13:15:12.000Z");
    await expect(vault.requireFreshSudo(sessionId)).resolves.toBe(sudoToken);
    current = new Date("2026-09-21T13:16:00.000Z");
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "expired" });
  });

  it("caps a sudo lifetime that exceeds the contract window", async () => {
    const { vault, repository } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-22T13:15:18.000Z"));
    expect(repository.entries.get(sessionId)?.expiresAt).toEqual(
      new Date(now.getTime() + SUDO_MAX_LIFETIME_SECONDS * 1_000),
    );
  });

  it("rejects a sudo grant that is already expired or malformed before touching storage", async () => {
    const { vault, repository } = fixture();
    await expect(vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:10:18.000Z")))
      .rejects.toThrow(/expir/);
    await expect(vault.storeSudo(sessionId, sudoToken, new Date(Number.NaN))).rejects.toThrow(/expir/);
    await expect(vault.storeSudo(sessionId, "", new Date("2026-09-21T13:15:18.000Z"))).rejects.toThrow(/token/);
    await expect(vault.storeSudo(sessionId, "not a jws", new Date("2026-09-21T13:15:18.000Z"))).rejects.toThrow(/token/);
    await expect(vault.storeSudo("not-a-session", sudoToken, new Date("2026-09-21T13:15:18.000Z"))).rejects.toThrow(/session/);
    expect(repository.writes).toBe(0);
  });

  it("fails when the session is no longer active instead of storing orphaned material", async () => {
    const { vault, repository } = fixture();
    repository.active.delete(sessionId);
    await expect(vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z")))
      .rejects.toBeInstanceOf(SudoSessionInactiveError);
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });
  });

  it("discards unreadable material and asks for a fresh proof", async () => {
    const { vault, repository } = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    repository.entries.set(sessionId, {
      ciphertext: "{\"v\":1,\"kid\":\"other-key\",\"iv\":\"AA\",\"ciphertext\":\"AA\",\"tag\":\"AA\"}",
      expiresAt: new Date("2026-09-21T13:15:18.000Z"),
    });
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });
    expect(repository.entries.has(sessionId)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(sessionId);
    expect(String(warn.mock.calls[0]?.[0])).toContain("sudo_decrypt_failed");
    warn.mockRestore();
  });

  it("clears the sudo on demand", async () => {
    const { vault, repository } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    await vault.clearSudo(sessionId);
    expect(repository.entries.has(sessionId)).toBe(false);
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });
  });

  it("keeps the token out of the error surface", async () => {
    const { vault } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"));
    const error = new SudoRequiredError("expired", ["password"]);
    expect(error.message).toBe("A fresh sudo proof is required (expired).");
    expect(error.name).toBe("SudoRequiredError");
    expect(JSON.stringify(error)).not.toContain(sudoToken);
  });
});
