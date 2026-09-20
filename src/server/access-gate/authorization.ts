import "server-only";

import { randomUUID } from "node:crypto";
import type { AccountAccessDecision, AccountAccessGate } from "@/server/access-gate/gate";

type SubjectSessionRevoker = {
  revokeSubject(subject: string): Promise<number>;
};

export class AccountAccessAuthorizer {
  constructor(
    private readonly gate: AccountAccessGate,
    private readonly sessions: SubjectSessionRevoker,
  ) {}

  async authorize(subject: string, requestId: string = randomUUID()): Promise<AccountAccessDecision> {
    const decision = await this.gate.decide(subject);
    if (decision === "blocked") {
      try {
        await this.sessions.revokeSubject(subject);
      } catch {
        this.log(requestId, "unavailable");
        return "unavailable";
      }
    }
    this.log(requestId, decision);
    return decision;
  }

  ready() {
    return this.gate.ready();
  }

  async requireActive(subject: string, requestId?: string) {
    const decision = await this.authorize(subject, requestId);
    if (decision === "blocked") throw new AccountAccessBlockedError();
    if (decision === "unavailable") throw new AccountAccessUnavailableError();
  }

  private log(requestId: string, decision: AccountAccessDecision) {
    const entry = JSON.stringify({
      event: "account_access_gate",
      requestId,
      decision,
    });
    if (decision === "active") console.info(entry);
    else console.warn(entry);
  }
}

export class AccountAccessBlockedError extends Error {
  constructor() {
    super("Account access was denied.");
    this.name = "AccountAccessBlockedError";
  }
}

export class AccountAccessUnavailableError extends Error {
  constructor() {
    super("Account access could not be verified.");
    this.name = "AccountAccessUnavailableError";
  }
}
