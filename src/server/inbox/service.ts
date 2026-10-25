import "server-only";

import { isInboxCursor, isInboxItemAction, isInboxItemId } from "@/lib/inbox";
import type { InboxCounts, InboxItem, InboxItemAction, InboxPage } from "@/lib/inbox";
import type { AccountReadService } from "@/server/keycloak-account/service";
import { SkyMailInboxError } from "@/server/skymail/inbox-client";
import type { SkyMailInboxClient } from "@/server/skymail/inbox-client";

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/** The browser asked for something the BFF does not forward (a cursor, an id or an action it does not know). */
export class InboxInputError extends Error {
  constructor() {
    super("Inbox request is invalid.");
    this.name = "InboxInputError";
  }
}

/**
 * The signed-in person's in-app inbox, through SkyMail with the session's own
 * user token (audience `skymail`, no role), as the preferences go to core.
 * The token never reaches the browser.
 */
export class InboxService {
  constructor(
    private readonly skymail: SkyMailInboxClient,
    private readonly tokens: TokenSource,
  ) {}

  /** A SkyMail 401 is retried once with a force-refreshed token; every other failure surfaces unchanged. */
  async #withToken<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.tokens.accessToken(session);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof SkyMailInboxError) || error.failure !== "unauthorized") throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  list(session: SessionIdentity, cursor?: string | null): Promise<InboxPage> {
    if (cursor !== undefined && cursor !== null && !isInboxCursor(cursor)) throw new InboxInputError();
    return this.#withToken(session, (token) => this.skymail.list(token, cursor ?? undefined));
  }

  counts(session: SessionIdentity): Promise<InboxCounts> {
    return this.#withToken(session, (token) => this.skymail.counts(token));
  }

  mark(session: SessionIdentity, id: unknown, action: unknown): Promise<InboxItem> {
    if (!isInboxItemId(id) || !isInboxItemAction(action)) throw new InboxInputError();
    return this.#withToken(session, (token) => this.skymail.mark(token, id, action as InboxItemAction));
  }

  markAll(session: SessionIdentity, action: "read-all" | "seen-all"): Promise<number> {
    return this.#withToken(session, (token) => this.skymail.markAll(token, action));
  }
}

type InboxDependencies = {
  account: TokenSource;
  skymailInbox?: SkyMailInboxClient | null;
};

const instances = new WeakMap<InboxDependencies, InboxService | null>();

/** The inbox service for a services registry, or `null` when `SKYMAIL_API_URL` is unset. */
export function inboxServiceFor(services: InboxDependencies): InboxService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.skymailInbox ? new InboxService(services.skymailInbox, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
