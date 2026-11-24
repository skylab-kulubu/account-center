import "server-only";

import { isTicketId } from "@/lib/tickets";
import type { AccountTicket } from "@/lib/tickets";
import { CoreTicketsError } from "@/server/core/tickets-client";
import type { CoreTicketsClient } from "@/server/core/tickets-client";
import type { AccountReadService } from "@/server/keycloak-account/service";

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/**
 * The signed-in person's tickets ("Biletlerim"), through core with the
 * session's own user token (audience `core`), as SkyPass does.
 */
export class TicketsService {
  constructor(
    private readonly core: CoreTicketsClient,
    private readonly tokens: TokenSource,
  ) {}

  /** A core 401 is retried once with a force-refreshed token; every other failure surfaces unchanged. */
  async #withToken<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.tokens.accessToken(session);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof CoreTicketsError) || error.failure !== "unauthorized") throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  mine(session: SessionIdentity): Promise<AccountTicket[]> {
    return this.#withToken(session, (accessToken) => this.core.mine(accessToken));
  }

  cancel(session: SessionIdentity, ticketId: unknown): Promise<void> {
    if (!isTicketId(ticketId)) throw new CoreTicketsError("invalid_input");
    return this.#withToken(session, (accessToken) => this.core.cancel(accessToken, ticketId));
  }
}

type TicketsDependencies = {
  account: TokenSource;
  coreTickets?: CoreTicketsClient | null;
};

const instances = new WeakMap<TicketsDependencies, TicketsService | null>();

/** The tickets service for a services registry, or `null` when `CORE_API_URL` is unset. */
export function ticketsServiceFor(services: TicketsDependencies): TicketsService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.coreTickets ? new TicketsService(services.coreTickets, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
