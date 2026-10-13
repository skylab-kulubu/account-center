import "server-only";

import { isPreferenceCategory, MAX_PREFERENCE_CHANGES } from "@/lib/communication-preferences";
import type { CommunicationPreferencesView, PreferenceChange } from "@/lib/communication-preferences";
import { CoreCommunicationPreferencesError } from "@/server/core/communication-preferences-client";
import type { CoreCommunicationPreferencesClient } from "@/server/core/communication-preferences-client";
import type { AccountReadService } from "@/server/keycloak-account/service";

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/** The browser sent a body the BFF does not forward. */
export class CommunicationPreferencesInputError extends Error {
  constructor() {
    super("Communication preference change is invalid.");
    this.name = "CommunicationPreferencesInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `{"items": [{"category", "enabled": true|false|null}]}` from the browser:
 * 1 to 200 items, each category once, nothing else. The channel is not the
 * browser's to choose; the client adds e-mail.
 */
export function parsePreferenceChanges(body: unknown): PreferenceChange[] {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "items") || !Array.isArray(body.items)) {
    throw new CommunicationPreferencesInputError();
  }
  const { items } = body;
  if (items.length === 0 || items.length > MAX_PREFERENCE_CHANGES) throw new CommunicationPreferencesInputError();
  const seen = new Set<string>();
  return items.map((item) => {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => key !== "category" && key !== "enabled") ||
      !isPreferenceCategory(item.category) ||
      seen.has(item.category) ||
      !Object.hasOwn(item, "enabled") ||
      (item.enabled !== null && typeof item.enabled !== "boolean")
    ) {
      throw new CommunicationPreferencesInputError();
    }
    seen.add(item.category);
    return { category: item.category, enabled: item.enabled };
  });
}

/**
 * The signed-in person's communication preferences, through core with the
 * session's own user token (audience `core`), as the club profile does. No
 * Sudo mode: these are mail choices, not credentials.
 */
export class CommunicationPreferencesService {
  constructor(
    private readonly core: CoreCommunicationPreferencesClient,
    private readonly tokens: TokenSource,
  ) {}

  /**
   * A core 401 means the bearer was not accepted (expired between
   * validation and use), so the call is retried once with a force-refreshed
   * token; every other failure surfaces unchanged.
   */
  async #withToken<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.tokens.accessToken(session);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof CoreCommunicationPreferencesError) || error.failure !== "unauthorized") throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  read(session: SessionIdentity): Promise<CommunicationPreferencesView> {
    return this.#withToken(session, (accessToken) => this.core.read(accessToken));
  }

  /** Validates the browser body, then writes it; core answers the new screen. */
  update(session: SessionIdentity, body: unknown): Promise<CommunicationPreferencesView> {
    const changes = parsePreferenceChanges(body);
    return this.#withToken(session, (accessToken) => this.core.update(accessToken, changes));
  }
}

type CommunicationPreferencesDependencies = {
  account: TokenSource;
  coreCommunicationPreferences?: CoreCommunicationPreferencesClient | null;
};

const instances = new WeakMap<CommunicationPreferencesDependencies, CommunicationPreferencesService | null>();

/** The preferences service for a services registry, or `null` when `CORE_API_URL` is unset. */
export function communicationPreferencesServiceFor(
  services: CommunicationPreferencesDependencies,
): CommunicationPreferencesService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.coreCommunicationPreferences
      ? new CommunicationPreferencesService(services.coreCommunicationPreferences, services.account)
      : null;
    instances.set(services, instance);
  }
  return instance;
}
