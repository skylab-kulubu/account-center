import { describe, expect, it } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import type { SessionRepository, SessionUseOutcome, UseSessionInput } from "@/server/auth/repositories";
import type { NewSessionRecord } from "@/server/auth/types";
import { DeletedSessionTokenDecryptError, SessionManager } from "@/server/auth/sessions";

class MemorySessions implements SessionRepository {
  record?: NewSessionRecord & {
    previousHandleHash?: Buffer;
    previousHandleExpiresAt?: Date;
    revokedAt?: Date;
  };

  async insert(value: NewSessionRecord) {
    this.record = value;
  }

  async findByHandle(handleHash: Buffer, now: Date) {
    const row = this.record;
    if (!row || row.revokedAt || row.absoluteExpiresAt <= now || row.idleExpiresAt <= now) return null;
    const current = row.handleHash.equals(handleHash);
    const previous = row.previousHandleHash?.equals(handleHash) &&
      row.previousHandleExpiresAt && row.previousHandleExpiresAt > now;
    if (!current && !previous) return null;
    return {
      id: row.id,
      subject: row.subject,
      keycloakSid: row.keycloakSid,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      idleExpiresAt: row.idleExpiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    };
  }

  async useHandle(input: UseSessionInput): Promise<SessionUseOutcome | null> {
    const row = this.record;
    if (!row || row.revokedAt || row.absoluteExpiresAt <= input.now || row.idleExpiresAt <= input.now) return null;
    const current = row.handleHash.equals(input.handleHash);
    const previous = row.previousHandleHash?.equals(input.handleHash) &&
      row.previousHandleExpiresAt && row.previousHandleExpiresAt > input.now;
    if (!current && !previous) return null;
    if (input.authorizeSessionId && !input.authorizeSessionId(row.id)) return { proofRejected: true };
    const rotated = Boolean(
      input.allowRotation &&
      (previous ||
        (current &&
          row.rotatedAt.getTime() <= input.now.getTime() - input.rotateAfterSeconds * 1_000)),
    );
    if (rotated) {
      row.previousHandleHash = row.handleHash;
      row.previousHandleExpiresAt = new Date(input.now.getTime() + input.previousHandleGraceSeconds * 1_000);
      row.handleHash = input.replacementHandleHash;
      row.rotatedAt = input.now;
    }
    row.lastSeenAt = input.now;
    row.idleExpiresAt = new Date(
      Math.min(row.absoluteExpiresAt.getTime(), input.now.getTime() + input.idleTtlSeconds * 1_000),
    );
    return {
      rotated,
      session: {
        id: row.id,
        subject: row.subject,
        keycloakSid: row.keycloakSid,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        idleExpiresAt: row.idleExpiresAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
      },
    };
  }

  async revokeByHandle(handleHash: Buffer, revokedAt: Date) {
    if (!this.record || !this.record.handleHash.equals(handleHash)) return false;
    this.record.revokedAt = revokedAt;
    return true;
  }

  async revokeBySubject(subject: string, revokedAt: Date) {
    if (!this.record || this.record.subject !== subject || this.record.revokedAt) return 0;
    this.record.revokedAt = revokedAt;
    return 1;
  }

  async revokeSubjectBySessionId(sessionId: string, revokedAt: Date) {
    if (!this.record || this.record.id !== sessionId) return 0;
    return this.revokeBySubject(this.record.subject, revokedAt);
  }

  async getTokenCiphertext(id: string, now: Date) {
    if (
      !this.record ||
      this.record.id !== id ||
      this.record.revokedAt ||
      this.record.idleExpiresAt <= now ||
      this.record.absoluteExpiresAt <= now
    ) return null;
    return this.record.tokenCiphertext;
  }

  async replaceTokenCiphertext(
    id: string,
    expectedCiphertext: string,
    replacementCiphertext: string,
    keycloakSid: string | undefined,
    now: Date,
  ) {
    if (
      !this.record ||
      this.record.id !== id ||
      this.record.tokenCiphertext !== expectedCiphertext ||
      this.record.revokedAt ||
      this.record.idleExpiresAt <= now ||
      this.record.absoluteExpiresAt <= now
    ) return false;
    this.record.tokenCiphertext = replacementCiphertext;
    if (keycloakSid) this.record.keycloakSid = keycloakSid;
    return true;
  }

  async revokeById(id: string, revokedAt: Date) {
    if (!this.record || this.record.id !== id) return false;
    this.record.revokedAt = revokedAt;
    return true;
  }

  async deleteByIdReturningToken(id: string) {
    if (!this.record || this.record.id !== id) return null;
    const tokenCiphertext = this.record.tokenCiphertext;
    this.record = undefined;
    return tokenCiphertext;
  }
}

const tokens = {
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  idToken: "id-secret",
  tokenType: "bearer",
};

const authenticatedAt = new Date("2026-09-20T00:00:00Z");

describe("SessionManager", () => {
  it("bounds the local absolute deadline by the verified upstream authentication time", async () => {
    const now = new Date("2026-09-20T01:00:00Z");
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      Buffer.alloc(32, 8),
      {
        absoluteTtlSeconds: 8 * 60 * 60,
        upstreamSessionMaxSeconds: 4 * 60 * 60,
        idleTtlSeconds: 600,
        rotationSeconds: 60,
        previousHandleGraceSeconds: 30,
      },
      () => now,
    );

    await manager.create({
      subject: "upstream-bounded-user",
      authenticatedAt: new Date("2026-09-19T22:00:00Z"),
      tokens,
    });
    expect(repository.record?.absoluteExpiresAt).toEqual(new Date("2026-09-20T02:00:00Z"));

    await expect(
      manager.create({
        subject: "expired-upstream-user",
        authenticatedAt: new Date("2026-09-19T20:00:00Z"),
        tokens,
      }),
    ).rejects.toThrow(/upstream.*expired/i);
  });

  it("stores only a handle hash, encrypts tokens, and rotates due handles", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      Buffer.alloc(32, 8),
      { absoluteTtlSeconds: 3600, upstreamSessionMaxSeconds: 3600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
      () => now,
    );
    const created = await manager.create({ subject: "user-id", authenticatedAt, tokens });

    expect(repository.record?.tokenCiphertext).not.toContain("access-secret");
    expect(repository.record?.handleHash.toString("utf8")).not.toBe(created.handle);
    await expect(manager.authenticate(created.handle)).resolves.toMatchObject({ rotated: false });

    now = new Date("2026-09-20T00:01:01Z");
    const rotated = await manager.authenticate(created.handle, { allowRotation: true });
    expect(rotated?.rotated).toBe(true);
    expect(rotated?.rotatedHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(manager.authenticate(created.handle)).resolves.not.toBeNull();

    now = new Date("2026-09-20T00:01:32Z");
    await expect(manager.authenticate(created.handle)).resolves.toBeNull();
    await expect(manager.authenticate(rotated?.rotatedHandle)).resolves.not.toBeNull();
  });

  it("recovers when a rotation response is lost before the browser stores its cookie", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      Buffer.alloc(32, 8),
      {
        absoluteTtlSeconds: 3_600,
        upstreamSessionMaxSeconds: 3_600,
        idleTtlSeconds: 600,
        rotationSeconds: 60,
        previousHandleGraceSeconds: 30,
      },
      () => now,
    );
    const created = await manager.create({ subject: "rotation-recovery", authenticatedAt, tokens });

    now = new Date("2026-09-20T00:01:01Z");
    const lostResponse = await manager.authenticate(created.handle, { allowRotation: true });
    expect(lostResponse?.rotatedHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const recovered = await manager.authenticate(created.handle, { allowRotation: true });
    expect(recovered?.rotatedHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(manager.authenticate(lostResponse?.rotatedHandle)).resolves.not.toBeNull();
    await expect(manager.authenticate(recovered?.rotatedHandle)).resolves.not.toBeNull();
  });

  it("binds CSRF values to one active session", async () => {
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 1)),
      Buffer.alloc(32, 2),
      { absoluteTtlSeconds: 3600, upstreamSessionMaxSeconds: 3600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
    );
    const created = await manager.create({ subject: "user-id", authenticatedAt: new Date(), tokens });
    const sessionId = repository.record!.id;
    const token = manager.csrfToken(sessionId);
    await expect(manager.authenticateMutation(created.handle, token)).resolves.toMatchObject({ status: "active" });
    await expect(manager.authenticateMutation(created.handle, manager.csrfToken("different"))).resolves.toEqual({ status: "forbidden" });
  });

  it("binds opaque upstream-session references to one local session and one upstream id", () => {
    const manager = new SessionManager(
      new MemorySessions(),
      new AesGcmSecretCipher(Buffer.alloc(32, 1)),
      Buffer.alloc(32, 2),
      { absoluteTtlSeconds: 3600, upstreamSessionMaxSeconds: 3600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
    );

    const reference = manager.upstreamSessionReference("local-one", "keycloak-one");

    expect(reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reference).not.toContain("keycloak-one");
    expect(manager.verifyUpstreamSessionReference("local-one", "keycloak-one", reference)).toBe(true);
    expect(manager.verifyUpstreamSessionReference("local-two", "keycloak-one", reference)).toBe(false);
    expect(manager.verifyUpstreamSessionReference("local-one", "keycloak-two", reference)).toBe(false);
    expect(manager.verifyUpstreamSessionReference("local-one", "keycloak-one", "x".repeat(43))).toBe(false);
  });

  it("rejects idle-expired, absolute-expired, and revoked sessions", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const makeManager = (policy: {
      absoluteTtlSeconds: number;
      idleTtlSeconds: number;
    }) => {
      const repository = new MemorySessions();
      const manager = new SessionManager(
        repository,
        new AesGcmSecretCipher(Buffer.alloc(32, 4)),
        Buffer.alloc(32, 5),
        { ...policy, upstreamSessionMaxSeconds: policy.absoluteTtlSeconds, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
        () => now,
      );
      return { manager, repository };
    };

    const idle = makeManager({ absoluteTtlSeconds: 3_600, idleTtlSeconds: 60 });
    const idleSession = await idle.manager.create({ subject: "idle-user", authenticatedAt: now, tokens });
    now = new Date("2026-09-20T00:01:01Z");
    await expect(idle.manager.authenticate(idleSession.handle)).resolves.toBeNull();

    now = new Date("2026-09-20T00:00:00Z");
    const absolute = makeManager({ absoluteTtlSeconds: 60, idleTtlSeconds: 600 });
    const absoluteSession = await absolute.manager.create({ subject: "absolute-user", authenticatedAt: now, tokens });
    now = new Date("2026-09-20T00:01:01Z");
    await expect(absolute.manager.authenticate(absoluteSession.handle)).resolves.toBeNull();

    now = new Date("2026-09-20T00:00:00Z");
    const revoked = makeManager({ absoluteTtlSeconds: 3_600, idleTtlSeconds: 600 });
    const revokedSession = await revoked.manager.create({ subject: "revoked-user", authenticatedAt: now, tokens });
    await expect(revoked.manager.revokeHandle(revokedSession.handle)).resolves.toBe(true);
    await expect(revoked.manager.authenticate(revokedSession.handle)).resolves.toBeNull();
  });

  it("hard-deletes the local session and returns decrypted tokens for upstream revocation", async () => {
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 6)),
      Buffer.alloc(32, 7),
      { absoluteTtlSeconds: 3_600, upstreamSessionMaxSeconds: 3_600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
    );
    await manager.create({ subject: "logout-user", authenticatedAt: new Date(), tokens });
    const sessionId = repository.record!.id;

    await expect(manager.deleteSessionAndGetTokens(sessionId)).resolves.toEqual(tokens);
    expect(repository.record).toBeUndefined();
    await expect(manager.deleteSessionAndGetTokens(sessionId)).resolves.toBeNull();
  });

  it("reads and compare-and-swaps encrypted active-session token material", async () => {
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 6)),
      Buffer.alloc(32, 7),
      { absoluteTtlSeconds: 3_600, upstreamSessionMaxSeconds: 3_600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
    );
    await manager.create({ subject: "read-token-user", authenticatedAt: new Date(), tokens });
    const sessionId = repository.record!.id;
    const snapshot = await manager.readTokens(sessionId);

    expect(snapshot?.tokens).toEqual(tokens);
    await expect(manager.replaceTokens(sessionId, "stale-version", {
      ...tokens,
      accessToken: "replacement-access",
    })).resolves.toBe(false);
    await expect(manager.replaceTokens(sessionId, snapshot!.version, {
      ...tokens,
      accessToken: "replacement-access",
    }, "fresh-keycloak-sid")).resolves.toBe(true);
    await expect(manager.readTokens(sessionId)).resolves.toMatchObject({
      tokens: { accessToken: "replacement-access" },
    });
    expect(repository.record?.keycloakSid).toBe("fresh-keycloak-sid");
    expect(repository.record?.tokenCiphertext).not.toContain("replacement-access");
  });

  it("reports corrupt token material only after the session row is hard-deleted", async () => {
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 6)),
      Buffer.alloc(32, 7),
      { absoluteTtlSeconds: 3_600, upstreamSessionMaxSeconds: 3_600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
    );
    await manager.create({ subject: "corrupt-token-user", authenticatedAt: new Date(), tokens });
    const sessionId = repository.record!.id;
    repository.record!.tokenCiphertext = "not-an-encrypted-token-envelope";

    await expect(manager.deleteSessionAndGetTokens(sessionId)).rejects.toBeInstanceOf(
      DeletedSessionTokenDecryptError,
    );
    expect(repository.record).toBeUndefined();
  });
});
