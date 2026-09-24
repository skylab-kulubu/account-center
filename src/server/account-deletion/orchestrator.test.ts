// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import {
  CoreAccountDeletionUnauthorizedError,
  CoreAccountDeletionUnavailableError,
} from "@/server/account-deletion/core-gateway";
import {
  AccountDeletionOrchestrator,
  AccountDeletionProofError,
  AccountDeletionSudoRejectedError,
  AccountDeletionUnavailableError,
} from "@/server/account-deletion/orchestrator";
import type {
  AcceptedAccountDeletionIntent,
  AccountDeletionIntent,
  AccountDeletionRepository,
  AwaitingConfirmationIntent,
  CoreAccountDeletionGateway,
  CoreAccountDeletionStatus,
  CoreReceiptIntent,
  LocalRecoveryIntent,
} from "@/server/account-deletion/types";
import type { ActiveSession } from "@/server/auth/types";

const now = new Date("2026-09-20T12:00:00.000Z");
const coreReceipt = `adr_${"r".repeat(43)}`;
const coreStatus: CoreAccountDeletionStatus = {
  receipt: coreReceipt,
  status: "processing",
  partial: true,
  requestedAt: "2026-09-20T12:00:01.000Z",
  updatedAt: "2026-09-20T12:00:02.000Z",
  completedAt: null,
  receiptExpiresAt: "2026-10-20T12:00:01.000Z",
};
const session: ActiveSession = {
  id: "11111111-1111-4111-8111-111111111111",
  subject: "subject-only-from-session",
  keycloakSid: "upstream-session",
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  lastSeenAt: now,
  idleExpiresAt: new Date("2026-09-20T12:30:00.000Z"),
  absoluteExpiresAt: new Date("2026-09-20T18:00:00.000Z"),
};

function acceptedStatus(status: CoreAccountDeletionStatus) {
  return status.status === "completed"
    ? {
        status: "completed" as const,
        partial: false as const,
        completedAt: new Date(status.completedAt),
      }
    : {
        status: status.status,
        partial: status.partial,
        completedAt: null,
      };
}

class MemoryDeletionRepository implements AccountDeletionRepository {
  intent?: AccountDeletionIntent;

  async saveReauthentication(input: AwaitingConfirmationIntent) {
    if (
      this.intent?.stage === "awaiting_confirmation" &&
      this.intent.subjectDigest.equals(input.subjectDigest)
    ) {
      const refreshed: AwaitingConfirmationIntent = {
        ...input,
        id: this.intent.id,
        createdAt: this.intent.createdAt,
      };
      this.intent = refreshed;
      return refreshed;
    }
    this.intent = input;
    return input;
  }

  async findAwaitingByProof(proofHash: Buffer, sessionId: string, at: Date) {
    if (
      this.intent?.stage !== "awaiting_confirmation" ||
      !this.intent.proofHash.equals(proofHash) ||
      this.intent.sessionId !== sessionId ||
      this.intent.freshUntil <= at
    ) return null;
    return this.intent;
  }

  async findByReceipt(receiptHash: Buffer, at: Date) {
    if (!this.intent) return null;
    if (
      (this.intent.stage === "awaiting_confirmation" || this.intent.stage === "local_recovery") &&
      this.intent.localReceiptHash.equals(receiptHash) &&
      this.intent.freshUntil > at
    ) return this.intent;
    if (
      this.intent.stage !== "awaiting_confirmation" &&
      this.intent.coreReceiptHash.equals(receiptHash) &&
      this.intent.receiptExpiresAt > at
    ) return this.intent;
    return null;
  }

  async acceptCore(
    awaiting: AwaitingConfirmationIntent,
    status: CoreAccountDeletionStatus,
    coreReceiptHash: Buffer,
    encryptedCoreReceipt: string,
  ) {
    if (
      this.intent?.stage !== "awaiting_confirmation" ||
      this.intent.id !== awaiting.id ||
      !this.intent.proofHash.equals(awaiting.proofHash)
    ) return null;
    const accepted: LocalRecoveryIntent = {
      id: awaiting.id,
      stage: "local_recovery",
      localReceiptHash: awaiting.localReceiptHash,
      coreReceiptHash,
      encryptedCoreReceipt,
      ...acceptedStatus(status),
      requestedAt: new Date(status.requestedAt),
      receiptExpiresAt: new Date(status.receiptExpiresAt),
      freshUntil: awaiting.freshUntil,
      createdAt: awaiting.createdAt,
      updatedAt: new Date(status.updatedAt),
    };
    this.intent = accepted;
    return accepted;
  }

  async refreshLocalRecovery(
    local: LocalRecoveryIntent,
    status: CoreAccountDeletionStatus,
    encryptedCoreReceipt: string,
  ) {
    if (this.intent?.stage !== "local_recovery" || this.intent.id !== local.id) return null;
    const refreshed: LocalRecoveryIntent = {
      ...local,
      ...acceptedStatus(status),
      encryptedCoreReceipt,
      requestedAt: new Date(status.requestedAt),
      receiptExpiresAt: new Date(status.receiptExpiresAt),
      updatedAt: new Date(status.updatedAt),
    };
    this.intent = refreshed;
    return refreshed;
  }

  async recordCoreReceiptStatus(
    accepted: AcceptedAccountDeletionIntent,
    status: CoreAccountDeletionStatus,
  ) {
    if (this.intent?.stage === "awaiting_confirmation" || this.intent?.id !== accepted.id) {
      return null;
    }
    const recorded: CoreReceiptIntent = {
      id: accepted.id,
      stage: "core_receipt",
      coreReceiptHash: accepted.coreReceiptHash,
      ...acceptedStatus(status),
      requestedAt: new Date(status.requestedAt),
      receiptExpiresAt: new Date(status.receiptExpiresAt),
      freshUntil: accepted.freshUntil,
      createdAt: accepted.createdAt,
      updatedAt: new Date(status.updatedAt),
    };
    this.intent = recorded;
    return recorded;
  }
}

function fixture(
  overrides: Partial<CoreAccountDeletionGateway> = {},
  revokeSubjectSessionsBySessionId = vi.fn().mockResolvedValue(2),
) {
  const repository = new MemoryDeletionRepository();
  const core: CoreAccountDeletionGateway = {
    initiate: vi.fn().mockResolvedValue(coreStatus),
    status: vi.fn().mockResolvedValue(coreStatus),
    retry: vi.fn().mockResolvedValue(coreStatus),
    ...overrides,
  };
  const orchestrator = new AccountDeletionOrchestrator(
    repository,
    core,
    { revokeSubjectSessionsBySessionId },
    new AesGcmSecretCipher(Buffer.alloc(32, 8)),
    Buffer.alloc(32, 9),
    () => now,
  );
  return { repository, core, revokeSubjectSessionsBySessionId, orchestrator };
}

/** The session's Sudo mode proof as the vault hands it out: opaque sky-account material and its deadline. */
const sudoProof = {
  sudoToken: "sudo-header.sudo-claims.sudo-signature",
  expiresAt: new Date("2026-09-20T12:04:00.000Z"),
};

async function reauthenticate(orchestrator: AccountDeletionOrchestrator) {
  return orchestrator.createReauthenticatedIntent({
    session,
    accessToken: "fresh-server-only-user-access-token",
    sudo: sudoProof,
  });
}

describe("account deletion orchestration", () => {
  it("bounds the proof and encrypted-token deadline by the sudo proof's own expiry", async () => {
    const { orchestrator, repository } = fixture();
    const result = await reauthenticate(orchestrator);

    // Five seconds of margin, the same the Sudo mode vault keeps before handing a proof out.
    expect(result.freshUntil).toEqual(new Date("2026-09-20T12:03:55.000Z"));
    expect(repository.intent).toMatchObject({
      stage: "awaiting_confirmation",
      freshUntil: new Date("2026-09-20T12:03:55.000Z"),
      encryptedIdentityTokens: expect.any(String),
    });
    expect(repository.intent?.stage === "awaiting_confirmation"
      ? repository.intent.encryptedIdentityTokens
      : "").not.toContain("sudo-signature");

    // Never longer than the five-minute window, whatever deadline the proof claims.
    await expect(orchestrator.createReauthenticatedIntent({
      session,
      accessToken: "access-token",
      sudo: { ...sudoProof, expiresAt: new Date("2026-09-20T12:15:00.000Z") },
    })).resolves.toMatchObject({ freshUntil: new Date("2026-09-20T12:05:00.000Z") });

    await expect(orchestrator.createReauthenticatedIntent({
      session,
      accessToken: "access-token",
      sudo: { ...sudoProof, expiresAt: new Date("2026-09-20T12:00:05.000Z") },
    })).rejects.toBeInstanceOf(AccountDeletionProofError);
    await expect(orchestrator.createReauthenticatedIntent({
      session,
      accessToken: "access-token",
      sudo: { ...sudoProof, expiresAt: new Date(Number.NaN) },
    })).rejects.toBeInstanceOf(AccountDeletionProofError);
  });

  it("never prepares an intent without both the bearer and the sudo proof", async () => {
    const { orchestrator, repository } = fixture();
    for (const input of [
      { session, accessToken: "access-token", sudo: { ...sudoProof, sudoToken: "" } },
      { session, accessToken: "", sudo: sudoProof },
    ]) {
      await expect(orchestrator.createReauthenticatedIntent(input))
        .rejects.toBeInstanceOf(AccountDeletionProofError);
    }
    expect(repository.intent).toBeUndefined();
  });

  it("presents the sealed sudo proof, revokes every local session, and transitions to local recovery", async () => {
    const { orchestrator, core, repository, revokeSubjectSessionsBySessionId } = fixture();
    const fresh = await reauthenticate(orchestrator);
    const result = await orchestrator.submit({
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    });

    expect(core.initiate).toHaveBeenCalledWith({
      accessToken: "fresh-server-only-user-access-token",
      sudoToken: sudoProof.sudoToken,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(revokeSubjectSessionsBySessionId).toHaveBeenCalledWith(session.id);
    expect(repository.intent).toMatchObject({
      stage: "local_recovery",
      encryptedCoreReceipt: expect.any(String),
    });
    expect(repository.intent).not.toHaveProperty("encryptedIdentityTokens");
    expect(repository.intent).not.toHaveProperty("subjectDigest");
    expect(result).toMatchObject({ status: "processing", receipt: coreReceipt });
  });

  it("reports a sudo proof core refuses, without revoking or accepting anything", async () => {
    const initiate = vi.fn().mockRejectedValue(new CoreAccountDeletionUnauthorizedError());
    const { orchestrator, repository, revokeSubjectSessionsBySessionId } = fixture({ initiate });
    const fresh = await reauthenticate(orchestrator);

    await expect(orchestrator.submit({
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    })).rejects.toBeInstanceOf(AccountDeletionSudoRejectedError);
    expect(revokeSubjectSessionsBySessionId).not.toHaveBeenCalled();
    expect(repository.intent).toMatchObject({ stage: "awaiting_confirmation" });
  });

  it("keeps an unavailable intake retryable with the same sealed proof and idempotency key", async () => {
    const initiate = vi.fn()
      .mockRejectedValueOnce(new CoreAccountDeletionUnavailableError())
      .mockResolvedValue(coreStatus);
    const { orchestrator } = fixture({ initiate });
    const fresh = await reauthenticate(orchestrator);

    await expect(orchestrator.submit({
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    })).rejects.toBeInstanceOf(AccountDeletionUnavailableError);
    await expect(orchestrator.status(fresh.localReceipt)).resolves.toMatchObject({ status: "processing" });
    expect(initiate.mock.calls[1]?.[0]).toEqual(initiate.mock.calls[0]?.[0]);
    expect(initiate.mock.calls[1]?.[0]).toMatchObject({ sudoToken: sudoProof.sudoToken });
  });

  it("reuses one idempotency key after an uncertain response and recovers through the local receipt", async () => {
    const initiate = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(coreStatus);
    const { orchestrator } = fixture({ initiate });
    const fresh = await reauthenticate(orchestrator);

    await expect(orchestrator.submit({
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    })).rejects.toBeInstanceOf(AccountDeletionUnavailableError);
    await expect(orchestrator.status(fresh.localReceipt)).resolves.toMatchObject({
      status: "processing",
      receipt: coreReceipt,
    });
    expect(initiate.mock.calls[0]?.[0].idempotencyKey).toBe(
      initiate.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("keeps pre-acceptance credentials recoverable when local session revocation fails", async () => {
    const revoke = vi.fn()
      .mockRejectedValueOnce(new Error("postgres unavailable"))
      .mockResolvedValue(2);
    const initiate = vi.fn().mockResolvedValue(coreStatus);
    const { orchestrator, repository } = fixture({ initiate }, revoke);
    const fresh = await reauthenticate(orchestrator);

    await expect(orchestrator.submit({
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    })).rejects.toBeInstanceOf(AccountDeletionUnavailableError);
    expect(repository.intent).toMatchObject({
      stage: "awaiting_confirmation",
      encryptedIdentityTokens: expect.any(String),
    });
    await expect(orchestrator.status(fresh.localReceipt)).resolves.toMatchObject({
      status: "processing",
    });
    expect(initiate).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("keeps one idempotency identity across repeated reauthentication with only the latest proof", async () => {
    const initiate = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(coreStatus);
    const { orchestrator } = fixture({ initiate });
    const first = await reauthenticate(orchestrator);
    await expect(orchestrator.submit({
      session,
      proofReference: first.proofReference,
      localReceipt: first.localReceipt,
      confirmation: "HESABIMI SİL",
    })).rejects.toBeInstanceOf(AccountDeletionUnavailableError);
    const refreshed = await orchestrator.createReauthenticatedIntent({
      session,
      accessToken: "replacement-access-token",
      sudo: { sudoToken: "replacement.sudo.token", expiresAt: new Date("2026-09-20T12:04:30.000Z") },
    });

    await expect(orchestrator.submit({
      session,
      proofReference: first.proofReference,
      localReceipt: first.localReceipt,
      confirmation: "HESABIMI SİL",
    })).rejects.toBeInstanceOf(AccountDeletionProofError);
    await orchestrator.submit({
      session,
      proofReference: refreshed.proofReference,
      localReceipt: refreshed.localReceipt,
      confirmation: "HESABIMI SİL",
    });
    expect(initiate.mock.calls[0]?.[0].idempotencyKey).toBe(
      initiate.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(initiate.mock.calls[1]?.[0]).toMatchObject({
      accessToken: "replacement-access-token",
      sudoToken: "replacement.sudo.token",
    });
  });

  it("rejects a stale proof, forged capabilities, another session, and non-exact confirmation", async () => {
    const { orchestrator, core } = fixture();
    await expect(orchestrator.createReauthenticatedIntent({
      session,
      accessToken: "fresh-token",
      sudo: { ...sudoProof, expiresAt: new Date("2026-09-20T11:59:00.000Z") },
    })).rejects.toThrow(/fresh/i);
    const fresh = await reauthenticate(orchestrator);
    const base = {
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    };
    await expect(orchestrator.submit({ ...base, proofReference: "x".repeat(43) })).rejects.toThrow(/proof/i);
    await expect(orchestrator.submit({ ...base, localReceipt: "x".repeat(43) })).rejects.toThrow(/proof/i);
    await expect(orchestrator.submit({
      ...base,
      session: { ...session, id: "99999999-9999-4999-8999-999999999999" },
    })).rejects.toThrow(/proof/i);
    await expect(orchestrator.submit({ ...base, confirmation: "hesabımı sil" })).rejects.toThrow(/confirmation/i);
    expect(core.initiate).not.toHaveBeenCalled();
  });

  it("confirms the Core receipt capability and removes local recovery material", async () => {
    const manual: CoreAccountDeletionStatus = {
      ...coreStatus,
      status: "manual_intervention",
      partial: true,
    };
    const { orchestrator, repository } = fixture({ status: vi.fn().mockResolvedValue(manual) });
    const fresh = await reauthenticate(orchestrator);
    await orchestrator.submit({
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    });

    await expect(orchestrator.status(coreReceipt)).resolves.toMatchObject({
      status: "manual_intervention",
      receipt: coreReceipt,
    });
    expect(repository.intent).toMatchObject({ stage: "core_receipt" });
    expect(repository.intent).not.toHaveProperty("localReceiptHash");
    expect(repository.intent).not.toHaveProperty("encryptedCoreReceipt");
    expect(JSON.stringify(await orchestrator.status(coreReceipt))).not.toContain(session.subject);
  });

  it("retries only manual-intervention requests with the Core receipt", async () => {
    const manual: CoreAccountDeletionStatus = {
      ...coreStatus,
      status: "manual_intervention",
      partial: true,
    };
    const pending: CoreAccountDeletionStatus = {
      ...coreStatus,
      status: "pending",
      partial: true,
    };
    const retry = vi.fn().mockResolvedValue(pending);
    const { orchestrator, core } = fixture({ initiate: vi.fn().mockResolvedValue(manual), retry });
    const fresh = await reauthenticate(orchestrator);
    await orchestrator.submit({
      session,
      proofReference: fresh.proofReference,
      localReceipt: fresh.localReceipt,
      confirmation: "HESABIMI SİL",
    });

    await expect(orchestrator.retry(coreReceipt)).resolves.toMatchObject({ status: "pending" });
    expect(retry).toHaveBeenCalledWith(coreReceipt);
    await expect(orchestrator.retry(`adr_${"f".repeat(43)}`)).rejects.toThrow(/proof/i);
    expect(core.initiate).toHaveBeenCalledTimes(1);
  });
});
