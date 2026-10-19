import "server-only";

import { isPreferenceCategory, MAX_PREFERENCE_CHANGES } from "@/lib/communication-preferences";
import type { CommunicationPreferencesView, PreferenceUpdate } from "@/lib/communication-preferences";
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

/** `{"enabled": true|false}`, nothing else: the tracking switch has no "forget". */
function parseTrackingChange(value: unknown) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "enabled") || typeof value.enabled !== "boolean") {
    throw new CommunicationPreferencesInputError();
  }
  return value.enabled;
}

/**
 * `{"items": [{"category", "enabled": true|false|null}], "tracking":
 * {"enabled": true|false}}` from the browser: up to 200 items, each
 * category once, `items`, `tracking` or both and nothing else. The channel
 * is not the browser's to choose; the client adds e-mail.
 */
export function parsePreferenceUpdate(body: unknown): PreferenceUpdate {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "items" && key !== "tracking")) {
    throw new CommunicationPreferencesInputError();
  }
  const items = body.items === undefined ? [] : body.items;
  const tracking = body.tracking === undefined ? undefined : parseTrackingChange(body.tracking);
  if (!Array.isArray(items) || items.length > MAX_PREFERENCE_CHANGES || (items.length === 0 && tracking === undefined)) {
    throw new CommunicationPreferencesInputError();
  }
  const seen = new Set<string>();
  const changes = items.map((item: unknown) => {
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
    return { category: item.category, enabled: item.enabled as boolean | null };
  });
  return tracking === undefined ? { items: changes } : { items: changes, tracking };
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
    const update = parsePreferenceUpdate(body);
    return this.#withToken(session, (accessToken) => this.core.update(accessToken, update));
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
