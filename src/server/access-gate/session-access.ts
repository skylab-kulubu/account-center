import "server-only";

import type { AccountAccessAuthorizer } from "@/server/access-gate/authorization";
import type { BrowserSession } from "@/server/auth/types";
import type { SessionManager } from "@/server/auth/sessions";

export type SessionAccessOutcome =
  | { status: "active"; value: BrowserSession }
  | { status: "blocked" }
  | { status: "unavailable" }
  | { status: "missing" }
  | { status: "forbidden" };

export class AccountSessionAccess {
  constructor(
    private readonly sessions: Pick<
      SessionManager,
      "candidate" | "authenticate" | "authenticateMutation" | "verifyCsrf"
    >,
    private readonly authorizer: Pick<AccountAccessAuthorizer, "authorize">,
  ) {}

  async authenticate(
    handle: string | undefined,
    options: { allowRotation?: boolean; requestId?: string } = {},
  ): Promise<SessionAccessOutcome> {
    const candidate = await this.sessions.candidate(handle);
    if (!candidate) return { status: "missing" };
    const decision = await this.authorizer.authorize(candidate.subject, options.requestId);
    if (decision !== "active") return { status: decision };
    const value = await this.sessions.authenticate(handle, {
      allowRotation: options.allowRotation,
    });
    return value ? { status: "active", value } : { status: "missing" };
  }

  async authenticateMutation(
    handle: string | undefined,
    csrfToken: string | undefined,
    options: { allowRotation?: boolean; requestId?: string } = {},
  ): Promise<SessionAccessOutcome> {
    if (!csrfToken) return { status: "forbidden" };
    const candidate = await this.sessions.candidate(handle);
    if (!candidate) return { status: "missing" };
    if (!this.sessions.verifyCsrf(candidate.id, csrfToken)) return { status: "forbidden" };
    const decision = await this.authorizer.authorize(candidate.subject, options.requestId);
    if (decision !== "active") return { status: decision };
    return this.sessions.authenticateMutation(handle, csrfToken, {
      allowRotation: options.allowRotation,
    });
  }
}
