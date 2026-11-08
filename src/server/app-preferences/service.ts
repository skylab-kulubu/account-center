import "server-only";

import type { AppPreferenceSummary } from "@/lib/app-preferences";
import { CoreAppPreferencesError } from "@/server/core/app-preferences-client";
import type { CoreAppPreferencesClient } from "@/server/core/app-preferences-client";
import type { AccountReadService } from "@/server/keycloak-account/service";

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/**
 * The signed-in person's App preferences summary and reset, through core
 * with the session's own user token, as the communication preferences do.
 * No Sudo mode: core asks for none, and a reset only brings an app's view
 * back to its default.
 *
 * Core answers 404 while the feature is off (`APP_PREFERENCE_CLIENTS`
 * empty) or for an app it does not map. The summary then reads as empty
 * and a reset as done: in both cases core holds nothing Account Center
 * could show or remove.
 */
export class AppPreferencesService {
  constructor(
    private readonly core: CoreAppPreferencesClient,
    private readonly tokens: TokenSource,
  ) {}

  /** A core 401 is retried once with a force-refreshed token; every other failure surfaces unchanged. */
  async #withToken<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.tokens.accessToken(session);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof CoreAppPreferencesError) || error.failure !== "unauthorized") throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  async summary(session: SessionIdentity): Promise<AppPreferenceSummary[]> {
    try {
      return await this.#withToken(session, (accessToken) => this.core.summary(accessToken));
    } catch (error) {
      if (error instanceof CoreAppPreferencesError && error.failure === "off") return [];
      throw error;
    }
  }

  async reset(session: SessionIdentity, app: string): Promise<void> {
    try {
      await this.#withToken(session, (accessToken) => this.core.reset(accessToken, app));
    } catch (error) {
      if (error instanceof CoreAppPreferencesError && error.failure === "off") return;
      throw error;
    }
  }
}

type AppPreferencesDependencies = {
  account: TokenSource;
  coreAppPreferences?: CoreAppPreferencesClient | null;
};

const instances = new WeakMap<AppPreferencesDependencies, AppPreferencesService | null>();

/** The service for a services registry, or `null` when `CORE_API_URL` is unset. */
export function appPreferencesServiceFor(services: AppPreferencesDependencies): AppPreferencesService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.coreAppPreferences ? new AppPreferencesService(services.coreAppPreferences, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
