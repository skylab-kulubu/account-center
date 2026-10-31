import "server-only";

import { TEAM_PAGE_PURPOSE, TEAM_PAGE_TEXT_VERSION } from "@/lib/team-page-consent";
import type { TeamPageConsentState } from "@/lib/team-page-consent";
import { CoreConsentError } from "@/server/core/consents-client";
import type { CoreConsentItem, CoreConsentsClient } from "@/server/core/consents-client";
import type { AccountReadService } from "@/server/keycloak-account/service";

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/** `active` when the account's own team page grant is open, else `none`. */
export function teamPageStateOf(items: readonly CoreConsentItem[]): TeamPageConsentState {
  return items.some((item) => item.purpose === TEAM_PAGE_PURPOSE && item.status === "active") ? "active" : "none";
}

/**
 * The signed-in person's team page consent, through core with the session's
 * own user token (audience `core`), as the promotional consent does. No
 * Sudo mode: turning it off is always one click away on the same page.
 */
export class TeamPageConsentService {
  constructor(
    private readonly core: CoreConsentsClient,
    private readonly tokens: TokenSource,
  ) {}

  /** A core 401 is retried once with a force-refreshed token; every other failure surfaces unchanged. */
  async #withToken<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.tokens.accessToken(session);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof CoreConsentError) || error.failure !== "unauthorized") throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  read(session: SessionIdentity): Promise<TeamPageConsentState> {
    return this.#withToken(session, async (accessToken) => teamPageStateOf(await this.core.list(accessToken)));
  }

  /** Records the grant on `ekip-sayfasi-v1`, named explicitly, from Account Center (`self`). */
  async grant(session: SessionIdentity): Promise<TeamPageConsentState> {
    await this.#withToken(session, (accessToken) => this.core.grant(accessToken, {
      purpose: TEAM_PAGE_PURPOSE,
      textVersion: TEAM_PAGE_TEXT_VERSION,
      source: "self",
    }));
    return "active";
  }

  async withdraw(session: SessionIdentity): Promise<TeamPageConsentState> {
    await this.#withToken(session, (accessToken) => this.core.withdraw(accessToken, TEAM_PAGE_PURPOSE));
    return "none";
  }
}

type TeamPageConsentDependencies = {
  account: TokenSource;
  coreConsents?: CoreConsentsClient | null;
};

const instances = new WeakMap<TeamPageConsentDependencies, TeamPageConsentService | null>();

/** The service for a services registry, or `null` when `CORE_API_URL` is unset. */
export function teamPageConsentServiceFor(services: TeamPageConsentDependencies): TeamPageConsentService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.coreConsents ? new TeamPageConsentService(services.coreConsents, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
