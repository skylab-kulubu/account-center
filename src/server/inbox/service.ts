import "server-only";

import { decodeJwt } from "jose";
import { isInboxCursor, isInboxItemAction, isInboxItemId } from "@/lib/inbox";
import type { InboxCounts, InboxItem, InboxItemAction, InboxPage } from "@/lib/inbox";
import type { AccountReadService } from "@/server/keycloak-account/service";
import { SkyNotifyInboxError } from "@/server/skynotify/inbox-client";
import type { SkyNotifyInboxClient } from "@/server/skynotify/inbox-client";

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
 * The signed-in person's in-app inbox, through SkyNotify with the session's own
 * user token (audience `skynotify`, no role), as the preferences go to core.
 * The token never reaches the browser.
 */
export class InboxService {
  constructor(
    private readonly skynotify: SkyNotifyInboxClient,
    private readonly tokens: TokenSource,
  ) {}

  /**
   * A token that does not name SkyNotify in its audience (a session from before e-skylab-keycloak's
   * iletişim-servisi 04, or that release not out yet) is not sent: SkyNotify would answer 401, and
   * forcing a refresh for the badge on every page would gain nothing. A SkyNotify 401 of a token that
   * names it is retried once with a force-refreshed token; every other failure surfaces unchanged.
   */
  async #withToken<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.tokens.accessToken(session);
    if (!namesSkyNotify(accessToken)) throw new SkyNotifyInboxError("not_enabled");
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof SkyNotifyInboxError) || error.failure !== "unauthorized") throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  list(session: SessionIdentity, cursor?: string | null): Promise<InboxPage> {
    if (cursor !== undefined && cursor !== null && !isInboxCursor(cursor)) throw new InboxInputError();
    return this.#withToken(session, (token) => this.skynotify.list(token, cursor ?? undefined));
  }

  counts(session: SessionIdentity): Promise<InboxCounts> {
    return this.#withToken(session, (token) => this.skynotify.counts(token));
  }

  mark(session: SessionIdentity, id: unknown, action: unknown): Promise<InboxItem> {
    if (!isInboxItemId(id) || !isInboxItemAction(action)) throw new InboxInputError();
    return this.#withToken(session, (token) => this.skynotify.mark(token, id, action as InboxItemAction));
  }

  markAll(session: SessionIdentity, action: "read-all" | "seen-all"): Promise<number> {
    return this.#withToken(session, (token) => this.skynotify.markAll(token, action));
  }
}

/** Whether the token's `aud` holds `skynotify`; a token that is no JWT does not. */
export function namesSkyNotify(accessToken: string): boolean {
  try {
    const { aud } = decodeJwt(accessToken);
    return aud === "skynotify" || (Array.isArray(aud) && aud.includes("skynotify"));
  } catch {
    return false;
  }
}

type InboxDependencies = {
  account: TokenSource;
  skynotifyInbox?: SkyNotifyInboxClient | null;
};

const instances = new WeakMap<InboxDependencies, InboxService | null>();

/** The inbox service for a services registry, or `null` when `SKYNOTIFY_API_URL` is unset. */
export function inboxServiceFor(services: InboxDependencies): InboxService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.skynotifyInbox ? new InboxService(services.skynotifyInbox, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
