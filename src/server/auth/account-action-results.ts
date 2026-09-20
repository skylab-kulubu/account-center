import "server-only";

import { randomOpaqueValue, sha256 } from "@/server/auth/crypto";
import type { AccountActionResultRepository } from "@/server/auth/repositories";
import type { AccountActionResult } from "@/server/auth/types";

const RESULT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class AccountActionResultStore {
  constructor(
    private readonly repository: AccountActionResultRepository,
    private readonly ttlSeconds = 300,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(sessionId: string, result: AccountActionResult) {
    const reference = randomOpaqueValue();
    const createdAt = this.clock();
    await this.repository.insert({
      resultHash: sha256(reference),
      sessionId,
      ...result,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.ttlSeconds * 1_000),
    });
    return reference;
  }

  consume(reference: string | null | undefined, sessionId: string) {
    if (!reference || !RESULT_REFERENCE_PATTERN.test(reference)) return Promise.resolve(null);
    return this.repository.consume(sha256(reference), sessionId, this.clock());
  }
}
