// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import {
  AccountDeletionOrchestrator,
  AccountDeletionProofError,
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

async function reauthenticate(orchestrator: AccountDeletionOrchestrator) {
  return orchestrator.createReauthenticatedIntent({
    session,
    authenticatedAt: new Date("2026-09-20T11:59:58.000Z"),
    freshAccessToken: "fresh-server-only-user-access-token",
    freshIdToken: "fresh-server-only-id-token",
  });
}

describe("account deletion orchestration", () => {
  it("anchors the proof and encrypted-token deadline to auth_time instead of callback time", async () => {
    const { orchestrator, repository } = fixture();
    const authenticatedAt = new Date("2026-09-20T11:55:00.001Z");
    const result = await orchestrator.createReauthenticatedIntent({
      session,
      authenticatedAt,
      freshAccessToken: "near-boundary-access-token",
      freshIdToken: "near-boundary-id-token",
    });

    expect(result.freshUntil).toEqual(new Date("2026-09-20T12:00:00.001Z"));
    expect(repository.intent).toMatchObject({
      stage: "awaiting_confirmation",
      freshUntil: new Date("2026-09-20T12:00:00.001Z"),
      encryptedIdentityTokens: expect.any(String),
    });
    await expect(orchestrator.createReauthenticatedIntent({
      session,
      authenticatedAt: new Date("2026-09-20T11:55:00.000Z"),
      freshAccessToken: "expired-access-token",
      freshIdToken: "expired-id-token",
    })).rejects.toThrow(/fresh/i);
  });

  it("uses only fresh BFF credentials, revokes every local session, and transitions to local recovery", async () => {
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
      reauthenticationToken: "fresh-server-only-id-token",
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
      authenticatedAt: new Date("2026-09-20T11:59:59.000Z"),
      freshAccessToken: "replacement-access-token",
      freshIdToken: "replacement-id-token",
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
      reauthenticationToken: "replacement-id-token",
    });
  });

  it("rejects stale auth, forged capabilities, another session, and non-exact confirmation", async () => {
    const { orchestrator, core } = fixture();
    await expect(orchestrator.createReauthenticatedIntent({
      session,
      authenticatedAt: new Date("2026-09-20T11:55:00.000Z"),
      freshAccessToken: "fresh-token",
      freshIdToken: "fresh-id-token",
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
