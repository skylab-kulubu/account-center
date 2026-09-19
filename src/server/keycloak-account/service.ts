import "server-only";

import type { OidcProtocol } from "@/server/auth/oidc-protocol";
import type { SessionManager } from "@/server/auth/sessions";
import type { ActiveSession, OidcTokenSet } from "@/server/auth/types";
import {
  AccountAccessTokenContractError,
  AccountAccessTokenExpiredError,
  validateAccountAccessToken,
} from "@/server/keycloak-account/access-token";
import { KeycloakAccountUnauthorizedError } from "@/server/keycloak-account/adapter";
import type { KeycloakAccountReadAdapter } from "@/server/keycloak-account/types";

export class AccountReauthenticationRequiredError extends Error {
  constructor() {
    super("The Account REST user token cannot be refreshed.");
    this.name = "AccountReauthenticationRequiredError";
  }
}

type SessionTokenVault = Pick<SessionManager, "readTokens" | "replaceTokens">;
type RefreshProtocol = Pick<OidcProtocol, "refresh" | "revokeRefreshToken">;
type SessionIdentity = Pick<ActiveSession, "id" | "subject">;

export class AccountReadService {
  constructor(
    private readonly adapter: KeycloakAccountReadAdapter,
    private readonly sessions: SessionTokenVault,
    private readonly oidc: RefreshProtocol,
    private readonly tokenContract: { issuer: URL; clientId: string },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  #validate(accessToken: string, session: SessionIdentity) {
    return validateAccountAccessToken(
      accessToken,
      { ...this.tokenContract, subject: session.subject },
      this.clock(),
    );
  }

  async #refresh(
    session: SessionIdentity,
    snapshot: { tokens: OidcTokenSet; version: string },
  ) {
    let refreshed: OidcTokenSet | undefined;
    try {
      refreshed = await this.oidc.refresh(snapshot.tokens);
      this.#validate(refreshed.accessToken, session);
    } catch (error) {
      if (error instanceof AccountAccessTokenContractError) {
        if (refreshed?.refreshToken) {
          await this.oidc.revokeRefreshToken(refreshed.refreshToken).catch(() => undefined);
        }
        throw error;
      }
      const winner = await this.sessions.readTokens(session.id);
      if (winner && winner.version !== snapshot.version) {
        this.#validate(winner.tokens.accessToken, session);
        return winner.tokens.accessToken;
      }
      throw new AccountReauthenticationRequiredError();
    }

    if (await this.sessions.replaceTokens(session.id, snapshot.version, refreshed)) {
      return refreshed.accessToken;
    }
    const winner = await this.sessions.readTokens(session.id);
    if (!winner) {
      if (refreshed.refreshToken) {
        await this.oidc.revokeRefreshToken(refreshed.refreshToken).catch(() => undefined);
      }
      throw new AccountReauthenticationRequiredError();
    }
    this.#validate(winner.tokens.accessToken, session);
    return winner.tokens.accessToken;
  }

  async #accessToken(session: SessionIdentity, forceRefresh = false) {
    const snapshot = await this.sessions.readTokens(session.id);
    if (!snapshot) throw new AccountReauthenticationRequiredError();
    let expiresAt: Date;
    try {
      ({ expiresAt } = this.#validate(snapshot.tokens.accessToken, session));
    } catch (error) {
      if (!(error instanceof AccountAccessTokenExpiredError)) throw error;
      return this.#refresh(session, snapshot);
    }
    if (forceRefresh || expiresAt.getTime() <= this.clock().getTime() + 30_000) {
      return this.#refresh(session, snapshot);
    }
    return snapshot.tokens.accessToken;
  }

  async #read<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.#accessToken(session);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof KeycloakAccountUnauthorizedError)) throw error;
      return operation(await this.#accessToken(session, true));
    }
  }

  profile(session: SessionIdentity) {
    return this.#read(session, (accessToken) => this.adapter.profile(accessToken));
  }

  authentication(session: SessionIdentity) {
    return this.#read(session, (accessToken) => this.adapter.authentication(accessToken));
  }

  sessionsList(session: SessionIdentity) {
    return this.#read(session, (accessToken) => this.adapter.sessions(accessToken));
  }

  overview(session: SessionIdentity) {
    return this.#read(session, async (accessToken) => {
      const [profile, authentication] = await Promise.all([
        this.adapter.profile(accessToken),
        this.adapter.authentication(accessToken),
      ]);
      return { profile, authentication };
    });
  }

  snapshot(session: SessionIdentity) {
    return this.#read(session, (accessToken) => this.adapter.snapshot(accessToken));
  }
}
