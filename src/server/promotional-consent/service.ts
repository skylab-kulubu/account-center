import "server-only";

import {
  isPromotionalConsentSource,
  PROMOTIONAL_PURPOSE,
  PROMOTIONAL_TEXT_VERSION,
} from "@/lib/promotional-consent";
import type { PromotionalConsentSource, PromotionalConsentState } from "@/lib/promotional-consent";
import { CoreConsentError } from "@/server/core/consents-client";
import type { CoreConsentItem, CoreConsentsClient } from "@/server/core/consents-client";
import type { AccountReadService } from "@/server/keycloak-account/service";

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/** The browser sent a body the BFF does not forward. */
export class PromotionalConsentInputError extends Error {
  constructor() {
    super("Promotional consent request is invalid.");
    this.name = "PromotionalConsentInputError";
  }
}

/** `active` when an open grant mails the person, `pending` when one only waits for its confirmation, else `none`. */
export function promotionalStateOf(items: readonly CoreConsentItem[]): PromotionalConsentState {
  const own = items.filter((item) => item.purpose === PROMOTIONAL_PURPOSE);
  if (own.some((item) => item.status === "active")) return "active";
  return own.some((item) => item.status === "pending") ? "pending" : "none";
}

/** `{"source": "self"}` from the browser, nothing else. */
export function parseGrantBody(body: unknown): PromotionalConsentSource {
  if (
    typeof body !== "object" || body === null || Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "source") ||
    !isPromotionalConsentSource((body as { source?: unknown }).source)
  ) {
    throw new PromotionalConsentInputError();
  }
  return (body as { source: PromotionalConsentSource }).source;
}

/**
 * The signed-in person's promotional consent, through core with the
 * session's own user token (audience `core`), as the communication
 * preferences do. No Sudo mode: every promotional mail carries a withdraw
 * link that needs no sign-in.
 */
export class PromotionalConsentService {
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

  read(session: SessionIdentity): Promise<PromotionalConsentState> {
    return this.#withToken(session, async (accessToken) => promotionalStateOf(await this.core.list(accessToken)));
  }

  /** Records the grant on `tanitim-v1`, named explicitly. */
  async grant(session: SessionIdentity, source: PromotionalConsentSource): Promise<PromotionalConsentState> {
    await this.#withToken(session, (accessToken) => this.core.grant(accessToken, {
      purpose: PROMOTIONAL_PURPOSE,
      textVersion: PROMOTIONAL_TEXT_VERSION,
      source,
    }));
    return "active";
  }

  async withdraw(session: SessionIdentity): Promise<PromotionalConsentState> {
    await this.#withToken(session, (accessToken) => this.core.withdraw(accessToken, PROMOTIONAL_PURPOSE));
    return "none";
  }
}

type PromotionalConsentDependencies = {
  account: TokenSource;
  coreConsents?: CoreConsentsClient | null;
};

const instances = new WeakMap<PromotionalConsentDependencies, PromotionalConsentService | null>();

/** The service for a services registry, or `null` when `CORE_API_URL` is unset. */
export function promotionalConsentServiceFor(services: PromotionalConsentDependencies): PromotionalConsentService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.coreConsents ? new PromotionalConsentService(services.coreConsents, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
