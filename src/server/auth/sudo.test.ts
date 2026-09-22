// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import type { StoredSudo, SudoRepository } from "@/server/auth/repositories";
import {
  SUDO_MAX_LIFETIME_SECONDS,
  SUDO_REAUTHENTICATION_LIFETIME_SECONDS,
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
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password");

    const stored = repository.entries.get(sessionId);
    expect(stored?.expiresAt).toEqual(new Date("2026-09-21T13:15:18.000Z"));
    expect(typeof stored?.ciphertext).toBe("string");
    expect(stored?.ciphertext).not.toContain(sudoToken);
    expect(JSON.parse(stored!.ciphertext)).toMatchObject({ v: 1 });
    expect(cipher.decrypt(stored!.ciphertext, `session:${sessionId}:sudo`)).toEqual({ sudoToken, method: "password" });
    expect(() => cipher.decrypt(stored!.ciphertext, `session:${sessionId}`)).toThrow();
    expect(() => cipher.decrypt(stored!.ciphertext, `session:${otherSessionId}:sudo`)).toThrow();
  });

  it("returns the plaintext token, method and deadline while the sudo is fresh", async () => {
    const { vault } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password");
    await expect(vault.requireFreshSudo(sessionId)).resolves.toEqual({
      sudoToken,
      method: "password",
      expiresAt: new Date("2026-09-21T13:15:18.000Z"),
    });
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "passkey");
    await expect(vault.requireFreshSudo(sessionId)).resolves.toMatchObject({ method: "passkey" });
  });

  it("stores a Microsoft re-authentication as a token-less proof bound to auth_time", async () => {
    const { vault, repository, cipher } = fixture();
    await vault.storeReauthenticationProof(sessionId, new Date("2026-09-21T13:09:18.000Z"));

    const stored = repository.entries.get(sessionId);
    expect(stored?.expiresAt).toEqual(new Date(
      new Date("2026-09-21T13:09:18.000Z").getTime() + SUDO_REAUTHENTICATION_LIFETIME_SECONDS * 1_000,
    ));
    expect(cipher.decrypt(stored!.ciphertext, `session:${sessionId}:sudo`)).toEqual({ sudoToken: null, method: "reauth" });
    await expect(vault.requireFreshSudo(sessionId)).resolves.toEqual({
      sudoToken: null,
      method: "reauth",
      expiresAt: new Date("2026-09-21T13:14:18.000Z"),
    });

    await expect(vault.storeReauthenticationProof(sessionId, new Date("2026-09-21T13:05:00.000Z")))
      .rejects.toThrow(/expir/);
    await expect(vault.storeReauthenticationProof(sessionId, new Date("2026-09-21T13:11:00.000Z")))
      .rejects.toThrow(/future/);
    await expect(vault.storeReauthenticationProof(sessionId, new Date(Number.NaN))).rejects.toThrow(/expir/);
    await expect(vault.storeReauthenticationProof("not-a-session", now)).rejects.toThrow(/session/);
  });

  it("stores the sky-account token a Microsoft re-authentication earned as a reauth proof", async () => {
    const { vault, repository, cipher } = fixture();
    // `POST sudo/authentication` answers `auth_time + 300`; the vault keeps that deadline.
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:14:18.000Z"), "reauth");

    const stored = repository.entries.get(sessionId);
    expect(stored?.expiresAt).toEqual(new Date("2026-09-21T13:14:18.000Z"));
    expect(cipher.decrypt(stored!.ciphertext, `session:${sessionId}:sudo`)).toEqual({ sudoToken, method: "reauth" });
    await expect(vault.requireFreshSudo(sessionId)).resolves.toEqual({
      sudoToken,
      method: "reauth",
      expiresAt: new Date("2026-09-21T13:14:18.000Z"),
    });
    // Such a proof is real SPI material, so the token-less fallback never overwrites it.
    await expect(vault.storeReauthenticationProof(sessionId, now)).resolves.toBe(false);
    await expect(vault.requireFreshSudo(sessionId)).resolves.toMatchObject({ sudoToken, method: "reauth" });
    expect(JSON.stringify(await vault.currentSudo(sessionId))).not.toContain(sudoToken);
    await expect(vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:14:18.000Z"), "microsoft" as never))
      .rejects.toThrow(/method/);
  });

  it("never replaces a fresh sky-account proof with a token-less re-authentication", async () => {
    let current = now;
    const { vault, repository } = fixture(() => current);
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "totp");
    const before = repository.entries.get(sessionId);

    await expect(vault.storeReauthenticationProof(sessionId, now)).resolves.toBe(false);
    expect(repository.entries.get(sessionId)).toBe(before);
    await expect(vault.requireFreshSudo(sessionId)).resolves.toMatchObject({ sudoToken, method: "totp" });

    // A stale token proof and an earlier re-authentication are replaced.
    current = new Date("2026-09-21T13:15:14.000Z");
    await expect(vault.storeReauthenticationProof(sessionId, current)).resolves.toBe(true);
    await expect(vault.requireFreshSudo(sessionId)).resolves.toMatchObject({ sudoToken: null, method: "reauth" });
    const earlier = repository.entries.get(sessionId);
    current = new Date("2026-09-21T13:16:00.000Z");
    await expect(vault.storeReauthenticationProof(sessionId, current)).resolves.toBe(true);
    expect(repository.entries.get(sessionId)).not.toBe(earlier);

    // Unreadable material is not worth keeping either.
    repository.entries.set(sessionId, {
      ciphertext: "{\"v\":1,\"kid\":\"other-key\",\"iv\":\"AA\",\"ciphertext\":\"AA\",\"tag\":\"AA\"}",
      expiresAt: new Date("2026-09-21T13:30:00.000Z"),
    });
    await expect(vault.storeReauthenticationProof(sessionId, current)).resolves.toBe(true);
    await expect(vault.requireFreshSudo(sessionId)).resolves.toMatchObject({ method: "reauth" });
  });

  it("reports the current proof without failing when there is none", async () => {
    const { vault } = fixture();
    await expect(vault.currentSudo(sessionId)).resolves.toBeNull();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "totp");
    await expect(vault.currentSudo(sessionId)).resolves.toEqual({
      method: "totp",
      expiresAt: new Date("2026-09-21T13:15:18.000Z"),
    });
    expect(JSON.stringify(await vault.currentSudo(sessionId))).not.toContain(sudoToken);
  });

  it("does not hand a token from one session record to another", async () => {
    const { vault, repository } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password");
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
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password");

    current = new Date("2026-09-21T13:15:14.000Z");
    const nearlyExpired = vault.requireFreshSudo(sessionId);
    await expect(nearlyExpired).rejects.toBeInstanceOf(SudoRequiredError);
    await expect(nearlyExpired).rejects.toMatchObject({ reason: "expired" });
    expect(repository.entries.has(sessionId)).toBe(false);

    current = now;
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password");
    current = new Date("2026-09-21T13:15:12.000Z");
    await expect(vault.requireFreshSudo(sessionId)).resolves.toMatchObject({ sudoToken });
    current = new Date("2026-09-21T13:16:00.000Z");
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "expired" });
  });

  it("caps a sudo lifetime that exceeds the contract window", async () => {
    const { vault, repository } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-22T13:15:18.000Z"), "totp");
    expect(repository.entries.get(sessionId)?.expiresAt).toEqual(
      new Date(now.getTime() + SUDO_MAX_LIFETIME_SECONDS * 1_000),
    );
  });

  it("rejects a sudo grant that is already expired or malformed before touching storage", async () => {
    const { vault, repository } = fixture();
    await expect(vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:10:18.000Z"), "password"))
      .rejects.toThrow(/expir/);
    await expect(vault.storeSudo(sessionId, sudoToken, new Date(Number.NaN), "password")).rejects.toThrow(/expir/);
    await expect(vault.storeSudo(sessionId, "", new Date("2026-09-21T13:15:18.000Z"), "password")).rejects.toThrow(/token/);
    await expect(vault.storeSudo(sessionId, "not a jws", new Date("2026-09-21T13:15:18.000Z"), "password")).rejects.toThrow(/token/);
    await expect(vault.storeSudo("not-a-session", sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password")).rejects.toThrow(/session/);
    await expect(vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "sms" as never)).rejects.toThrow(/method/);
    expect(repository.writes).toBe(0);
  });

  it("fails when the session is no longer active instead of storing orphaned material", async () => {
    const { vault, repository } = fixture();
    repository.active.delete(sessionId);
    await expect(vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password"))
      .rejects.toBeInstanceOf(SudoSessionInactiveError);
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });
  });

  it("discards unreadable material and asks for a fresh proof", async () => {
    const { vault, repository, cipher } = fixture();
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

    for (const envelope of [
      { sudoToken },
      { sudoToken, method: "sms" },
      { sudoToken: null, method: "password" },
      { sudoToken: "not a jws", method: "totp" },
      { sudoToken: "not a jws", method: "reauth" },
    ]) {
      repository.entries.set(sessionId, {
        ciphertext: cipher.encrypt(envelope, `session:${sessionId}:sudo`),
        expiresAt: new Date("2026-09-21T13:15:18.000Z"),
      });
      await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });
      expect(repository.entries.has(sessionId)).toBe(false);
    }
    warn.mockRestore();
  });

  it("clears the sudo on demand", async () => {
    const { vault, repository } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password");
    await vault.clearSudo(sessionId);
    expect(repository.entries.has(sessionId)).toBe(false);
    await expect(vault.requireFreshSudo(sessionId)).rejects.toMatchObject({ reason: "missing" });
  });

  it("keeps the token out of the error surface", async () => {
    const { vault } = fixture();
    await vault.storeSudo(sessionId, sudoToken, new Date("2026-09-21T13:15:18.000Z"), "password");
    const error = new SudoRequiredError("expired", ["password"]);
    expect(error.message).toBe("A fresh sudo proof is required (expired).");
    expect(error.name).toBe("SudoRequiredError");
    expect(JSON.stringify(error)).not.toContain(sudoToken);
  });
});
