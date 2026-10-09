import "server-only";

import { CoreSkyPassWalletError } from "@/server/core/skypass-wallet-client";
import type { CoreSkyPassWalletClient, CoreSkyPassWalletStatus } from "@/server/core/skypass-wallet-client";
import type { AccountReadService } from "@/server/keycloak-account/service";

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/**
 * SkyPass in Google Wallet for the signed-in person, through core with the
 * session's own user token (audience `core`), as the club profile does.
 * The save link passes through in memory only: it is returned to the route,
 * which answers it to the browser that asked, and is never kept or logged.
 */
export class SkyPassWalletService {
  constructor(
    private readonly core: CoreSkyPassWalletClient,
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
      if (!(error instanceof CoreSkyPassWalletError) || error.failure !== "unauthorized") throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  status(session: SessionIdentity): Promise<CoreSkyPassWalletStatus> {
    return this.#withToken(session, (accessToken) => this.core.status(accessToken));
  }

  googleSaveUrl(session: SessionIdentity): Promise<string> {
    return this.#withToken(session, (accessToken) => this.core.googleSaveUrl(accessToken));
  }

  revokeGoogle(session: SessionIdentity): Promise<void> {
    return this.#withToken(session, (accessToken) => this.core.revokeGoogle(accessToken));
  }
}

type SkyPassWalletDependencies = {
  account: TokenSource;
  coreSkyPassWallet?: CoreSkyPassWalletClient | null;
};

const instances = new WeakMap<SkyPassWalletDependencies, SkyPassWalletService | null>();

/** The wallet service for a services registry, or `null` when `CORE_API_URL` is unset. */
export function skyPassWalletServiceFor(services: SkyPassWalletDependencies): SkyPassWalletService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.coreSkyPassWallet ? new SkyPassWalletService(services.coreSkyPassWallet, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
