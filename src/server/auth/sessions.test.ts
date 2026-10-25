import { describe, expect, it } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import type { SessionRepository, SessionUseOutcome, UseSessionInput } from "@/server/auth/repositories";
import type { NewSessionRecord } from "@/server/auth/types";
import {
  DeletedSessionTokenDecryptError,
  SessionManager,
  UpstreamSessionExpiredError,
} from "@/server/auth/sessions";

class MemorySessions implements SessionRepository {
  record?: NewSessionRecord & {
    previousHandleHash?: Buffer;
    previousHandleExpiresAt?: Date;
    revokedAt?: Date;
    /** Mirrors account_sessions.rotation_salt (0010). */
    rotationSalt?: Buffer;
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
    // Mirrors PostgresSessionRepository: the previous handle gets its successor back, unchanged row.
    const sameSuccessor = Boolean(previous && input.allowRotation && row.rotationSalt &&
      input.successorHash(row.rotationSalt).equals(row.handleHash));
    const rotated = sameSuccessor || Boolean(
      input.allowRotation &&
      (previous ||
        (current &&
          row.rotatedAt.getTime() <= input.now.getTime() - input.rotateAfterSeconds * 1_000)),
    );
    const rotationSalt = sameSuccessor ? row.rotationSalt : rotated ? input.newRotationSalt : undefined;
    if (rotated && !sameSuccessor) {
      row.previousHandleHash = row.handleHash;
      row.previousHandleExpiresAt = new Date(input.now.getTime() + input.previousHandleGraceSeconds * 1_000);
      row.handleHash = input.successorHash(input.newRotationSalt);
      row.rotationSalt = input.newRotationSalt;
      row.rotatedAt = input.now;
    }
    row.lastSeenAt = input.now;
    row.idleExpiresAt = new Date(
      Math.min(row.absoluteExpiresAt.getTime(), input.now.getTime() + input.idleTtlSeconds * 1_000),
    );
    return {
      rotated,
      ...(rotationSalt ? { rotationSalt } : {}),
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
    ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
  });

  it("bounds a Web handoff session by the Keycloak session's start, not the app's original login", async () => {
    const now = new Date("2026-09-20T01:00:00Z");
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      Buffer.alloc(32, 8),
      {
        absoluteTtlSeconds: 8 * 60 * 60,
        upstreamSessionMaxSeconds: 8 * 60 * 60,
        idleTtlSeconds: 600,
        rotationSeconds: 60,
        previousHandleGraceSeconds: 30,
      },
      () => now,
    );

    await manager.create({
      subject: "handoff-user",
      authenticatedAt: new Date("2026-09-01T09:00:00Z"),
      upstreamSessionStartedAt: now,
      tokens,
    });
    expect(repository.record?.absoluteExpiresAt).toEqual(new Date("2026-09-20T09:00:00Z"));

    await expect(
      manager.create({
        subject: "handoff-user",
        authenticatedAt: new Date("2026-09-01T09:00:00Z"),
        upstreamSessionStartedAt: new Date("2026-09-20T01:00:06Z"),
        tokens,
      }),
    ).rejects.toThrow(/upstream session start/i);
  });

  it("ends a session with Keycloak's own session expiry when the ID token states it", async () => {
    const now = new Date("2026-09-20T01:00:00Z");
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      Buffer.alloc(32, 8),
      {
        absoluteTtlSeconds: 8 * 60 * 60,
        upstreamSessionMaxSeconds: 8 * 60 * 60,
        idleTtlSeconds: 600,
        rotationSeconds: 60,
        previousHandleGraceSeconds: 30,
      },
      () => now,
    );
    // A remember-me Keycloak session: logged in 20 days ago, Keycloak keeps it 30 days.
    const rememberedLogin = new Date("2026-08-31T01:00:00Z");

    await manager.create({
      subject: "remembered-user",
      authenticatedAt: rememberedLogin,
      upstreamSessionStartedAt: rememberedLogin,
      upstreamSessionExpiresAt: new Date("2026-09-30T01:00:00Z"),
      tokens,
    });
    expect(repository.record?.absoluteExpiresAt).toEqual(new Date("2026-09-20T09:00:00Z"));

    await manager.create({
      subject: "ending-soon-user",
      authenticatedAt: new Date("2026-09-19T20:00:00Z"),
      upstreamSessionStartedAt: now,
      upstreamSessionExpiresAt: new Date("2026-09-20T02:30:00Z"),
      tokens,
    });
    expect(repository.record?.absoluteExpiresAt).toEqual(new Date("2026-09-20T02:30:00Z"));

    for (const upstreamSessionExpiresAt of [now, new Date("2026-09-20T00:59:59Z")]) {
      await expect(
        manager.create({
          subject: "ended-user",
          authenticatedAt: new Date("2026-09-19T20:00:00Z"),
          upstreamSessionExpiresAt,
          tokens,
        }),
      ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
    }
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

    // The browser kept the original: it gets the same successor again, and nothing in the row moves.
    const recovered = await manager.authenticate(created.handle, { allowRotation: true });
    expect(recovered?.rotatedHandle).toBe(lostResponse?.rotatedHandle);
    await expect(manager.authenticate(lostResponse?.rotatedHandle)).resolves.not.toBeNull();
    await expect(manager.authenticate(created.handle)).resolves.not.toBeNull();
  });

  function rotatingManager(clock: () => Date, secret = Buffer.alloc(32, 8)) {
    const repository = new MemorySessions();
    const manager = new SessionManager(
      repository,
      new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      secret,
      { absoluteTtlSeconds: 3_600, upstreamSessionMaxSeconds: 3_600, idleTtlSeconds: 600, rotationSeconds: 60, previousHandleGraceSeconds: 30 },
      clock,
    );
    return { repository, manager };
  }

  it("gives every request that carries the previous handle in its window the same successor (two tabs, refresh beside a mutation)", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const { manager } = rotatingManager(() => now);
    const created = await manager.create({ subject: "rotation-race", authenticatedAt, tokens });
    now = new Date("2026-09-20T00:01:01Z");
    // Two rotating requests with the same handle, whichever takes the row first.
    const first = await manager.authenticate(created.handle, { allowRotation: true });
    const second = await manager.authenticate(created.handle, { allowRotation: true });
    expect(first?.rotatedHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second?.rotatedHandle).toBe(first?.rotatedHandle);
    // Whichever answer the browser keeps last, its cookie opens the session.
    await expect(manager.authenticate(first?.rotatedHandle)).resolves.not.toBeNull();
  });

  it("keeps a delivered successor that has not carried a request yet when a late old request comes", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const { manager } = rotatingManager(() => now);
    const created = await manager.create({ subject: "rotation-delivered", authenticatedAt, tokens });
    now = new Date("2026-09-20T00:01:01Z");
    const delivered = await manager.authenticate(created.handle, { allowRotation: true });
    // The late request's answer is lost too: the browser still holds the delivered successor.
    now = new Date("2026-09-20T00:01:05Z");
    const late = await manager.authenticate(created.handle, { allowRotation: true });
    expect(late?.rotatedHandle).toBe(delivered?.rotatedHandle);
    await expect(manager.authenticate(delivered?.rotatedHandle)).resolves.not.toBeNull();
  });

  it("ends the previous handle at its own expiry; the successor rotates on schedule", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const { manager } = rotatingManager(() => now);
    const created = await manager.create({ subject: "rotation-window", authenticatedAt, tokens });
    now = new Date("2026-09-20T00:01:01Z");
    const next = await manager.authenticate(created.handle, { allowRotation: true });
    now = new Date("2026-09-20T00:01:20Z");
    await manager.authenticate(created.handle, { allowRotation: true });
    now = new Date("2026-09-20T00:01:32Z");
    await expect(manager.authenticate(created.handle, { allowRotation: true })).resolves.toBeNull();
    now = new Date("2026-09-20T00:02:02Z");
    const after = await manager.authenticate(next?.rotatedHandle, { allowRotation: true });
    expect(after?.rotatedHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(after?.rotatedHandle).not.toBe(next?.rotatedHandle);
  });

  it("falls back to a fresh rotation when the row's current handle is not the derived successor (an older image rotated it)", async () => {
    let now = new Date("2026-09-20T00:00:00Z");
    const { repository, manager } = rotatingManager(() => now);
    const created = await manager.create({ subject: "rotation-old-image", authenticatedAt, tokens });
    // An older image rotated: the original is the previous handle, the current one random, the salt stale.
    const oldImageHandle = Buffer.alloc(32, 77);
    now = new Date("2026-09-20T00:01:01Z");
    repository.record!.previousHandleHash = repository.record!.handleHash;
    repository.record!.previousHandleExpiresAt = new Date("2026-09-20T00:01:31Z");
    repository.record!.handleHash = oldImageHandle;
    repository.record!.rotationSalt = Buffer.alloc(16, 5);
    const fresh = await manager.authenticate(created.handle, { allowRotation: true });
    expect(fresh?.rotatedHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // As before this change: the old image's handle stays valid as the previous one.
    expect(repository.record!.previousHandleHash).toEqual(oldImageHandle);
    await expect(manager.authenticate(fresh?.rotatedHandle)).resolves.not.toBeNull();
  });

  it("derives a successor no one can compute without the session secret", async () => {
    const now = new Date("2026-09-20T00:01:01Z");
    const created = new Date("2026-09-20T00:00:00Z");
    let clockA = created;
    let clockB = created;
    const a = rotatingManager(() => clockA, Buffer.alloc(32, 8));
    const b = rotatingManager(() => clockB, Buffer.alloc(32, 7));
    const sessionA = await a.manager.create({ subject: "secret-a", authenticatedAt, tokens });
    b.repository.record = { ...a.repository.record! };
    clockA = now;
    clockB = now;
    const fromA = await a.manager.authenticate(sessionA.handle, { allowRotation: true });
    const fromB = await b.manager.authenticate(sessionA.handle, { allowRotation: true });
    expect(fromA?.rotatedHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromB?.rotatedHandle).not.toBe(fromA?.rotatedHandle);
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
