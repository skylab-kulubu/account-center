import "server-only";

import { randomUUID } from "node:crypto";
import * as oauth from "oauth4webapi";
import { randomOpaqueValue } from "@/server/auth/crypto";
import { logAuthEvent } from "@/server/auth/logging";
import type { OidcProtocol } from "@/server/auth/oidc-protocol";
import type { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import type { SessionManager } from "@/server/auth/sessions";
import type {
  ActiveSession,
  SudoReauthenticationTransactionPayload,
  YtuLinkTransactionPayload,
} from "@/server/auth/types";
import type { AccountAccessAuthorizer } from "@/server/access-gate/authorization";

/**
 * How the `idp_link` round trip ended: Keycloak's own `kc_action_status`, or
 * `unverified` when the fresh token set could not be stored on this session.
 * `success` still has to be proven by re-reading the identity.
 */
export type YtuLinkCallbackStatus = "success" | "cancelled" | "error" | "unverified";

export type OidcFlowOptions = {
  /** Alias of the YTÜ Microsoft identity provider, the only `kc_action_parameter` ever pushed. */
  ytuIdpAlias: string;
  clock?: () => Date;
};

/** Account pages a login or a Sudo mode re-authentication may return to; mirrored in `oidc-transactions.ts`. */
const allowedReturnPaths = new Set([
  "/",
  "/identity",
  "/email",
  "/security",
  "/sessions",
  "/permissions",
  "/club-profile",
  "/delete-account",
]);

export class InvalidOidcTransactionError extends Error {
  constructor() {
    super("The OIDC transaction is invalid, expired, or already used.");
    this.name = "InvalidOidcTransactionError";
  }
}

export function normalizeReturnTo(value: string | null | undefined) {
  if (!value) return "/";
  try {
    const url = new URL(value, "https://account-center.invalid");
    if (url.origin !== "https://account-center.invalid" || !allowedReturnPaths.has(url.pathname)) return "/";
    return url.pathname;
  } catch {
    return "/";
  }
}

export class OidcFlowService {
  private readonly ytuIdpAlias: string;
  private readonly clock: () => Date;

  constructor(
    private readonly protocol: OidcProtocol,
    private readonly transactions: OidcTransactionStore,
    private readonly sessions: Pick<
      SessionManager,
      "authenticate" | "candidate" | "create" | "readTokens" | "replaceTokens"
    >,
    private readonly accountAccess: Pick<AccountAccessAuthorizer, "requireActive">,
    options: OidcFlowOptions,
  ) {
    this.ytuIdpAlias = options.ytuIdpAlias;
    this.clock = options.clock ?? (() => new Date());
  }

  async begin(returnTo?: string | null) {
    const proof = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
    };
    const authorization = await this.protocol.begin(proof);
    const browserBinding = randomOpaqueValue();
    await this.transactions.create(
      { ...proof, purpose: "login", returnTo: normalizeReturnTo(returnTo) },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  /**
   * Sudo mode fallback for a person without password, passkey or TOTP: a
   * forced re-authentication (`prompt=login&max_age=0`), returning to the
   * page that asked for sudo. The callback verifies the signed `auth_time` and
   * hands the fresh ID token to `POST sudo/authentication`, which turns it
   * into a sudo token for the same five-minute window.
   */
  async beginSudoReauthentication(session: ActiveSession, returnTo?: string | null) {
    const proof = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
      forceReauthentication: true,
    };
    const authorization = await this.protocol.begin(proof);
    const browserBinding = randomOpaqueValue();
    const initiatedAt = this.clock();
    await this.transactions.create(
      {
        state: proof.state,
        nonce: proof.nonce,
        codeVerifier: proof.codeVerifier,
        purpose: "sudo-reauthentication",
        returnTo: normalizeReturnTo(returnTo),
        expectedSubject: session.subject,
        expectedSessionId: session.id,
        initiatedAt: initiatedAt.toISOString(),
      },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  /**
   * "YTÜ hesabımı bağla": the `idp_link` application-initiated action for the
   * YTÜ Microsoft identity provider, bound to the current session and always
   * returning to the identity page. Keycloak itself takes the person to
   * Microsoft, so no `prompt=login` is requested; the callback exchanges the
   * code like a re-authentication and the route proves the link afterwards.
   */
  async beginYtuLink(session: ActiveSession) {
    const proof = {
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier: oauth.generateRandomCodeVerifier(),
      accountAction: { action: "idp_link" as const, parameter: this.ytuIdpAlias },
    };
    const authorization = await this.protocol.begin(proof);
    const browserBinding = randomOpaqueValue();
    const initiatedAt = this.clock();
    await this.transactions.create(
      {
        state: proof.state,
        nonce: proof.nonce,
        codeVerifier: proof.codeVerifier,
        purpose: "ytu-link",
        returnTo: "/identity",
        expectedSubject: session.subject,
        expectedSessionId: session.id,
        initiatedAt: initiatedAt.toISOString(),
      },
      browserBinding,
      authorization.expiresIn,
    );
    return { authorizationUrl: authorization.authorizationUrl, browserBinding };
  }

  async #boundActionSession(
    transaction: SudoReauthenticationTransactionPayload | YtuLinkTransactionPayload,
    sessionHandle: string | undefined,
  ) {
    const candidate = await this.sessions.candidate(sessionHandle);
    if (
      !candidate ||
      candidate.id !== transaction.expectedSessionId ||
      candidate.subject !== transaction.expectedSubject
    ) throw new InvalidOidcTransactionError();
    await this.accountAccess.requireActive(candidate.subject);
    const active = await this.sessions.authenticate(sessionHandle);
    if (
      !active ||
      active.session.id !== transaction.expectedSessionId ||
      active.session.subject !== transaction.expectedSubject
    ) throw new InvalidOidcTransactionError();
    return active.session;
  }

  async #sudoReauthenticationCallback(
    callbackUrl: URL,
    transaction: SudoReauthenticationTransactionPayload,
    sessionHandle: string | undefined,
  ) {
    const session = await this.#boundActionSession(transaction, sessionHandle);
    if (callbackUrl.searchParams.has("error")) {
      return {
        sudoReauthentication: "cancelled" as const,
        returnTo: transaction.returnTo,
      };
    }
    let authorization;
    try {
      authorization = await this.protocol.exchange({
        callbackUrl,
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        forceReauthentication: true,
      });
    } catch {
      throw new InvalidOidcTransactionError();
    }
    const initiatedAt = new Date(transaction.initiatedAt);
    if (
      authorization.subject !== transaction.expectedSubject ||
      !authorization.keycloakSid ||
      authorization.authenticatedAt.getTime() < initiatedAt.getTime() - 5_000
    ) {
      throw new InvalidOidcTransactionError();
    }
    await this.accountAccess.requireActive(authorization.subject);
    const currentTokens = await this.sessions.readTokens(session.id);
    if (!currentTokens) throw new InvalidOidcTransactionError();
    await this.sessions.replaceTokens(
      session.id,
      currentTokens.version,
      authorization.tokens,
      authorization.keycloakSid,
    );
    return {
      sudoReauthentication: "success" as const,
      session,
      authenticatedAt: authorization.authenticatedAt,
      // The proof the caller presents to `POST sudo/authentication`; it stays on the server.
      freshIdToken: authorization.tokens.idToken,
      returnTo: transaction.returnTo,
    };
  }

  /**
   * Return from the `idp_link` action. Keycloak answers with a code plus
   * `kc_action=idp_link&kc_action_status=success|cancelled|error`; anything
   * else (an OAuth error, a missing or different action, an unknown status, a
   * failed exchange) counts as `error` and changes nothing. A code that
   * exchanges is kept even when the action was cancelled, because Keycloak may
   * have rotated the session at Microsoft: the fresh token set replaces the
   * stored one (the `sid` may change) so the BFF session stays usable. The
   * identity at Keycloak must still be this session's person; the bound
   * session and subject are checked before anything is stored, and a token set
   * another request replaced meanwhile (a lost compare-and-swap) ends the
   * round trip as `unverified` rather than passing an unproven claim on.
   * `success` is a claim, not proof: the route re-reads the identity before
   * announcing it.
   */
  async #ytuLinkCallback(
    callbackUrl: URL,
    transaction: YtuLinkTransactionPayload,
    sessionHandle: string | undefined,
  ) {
    const session = await this.#boundActionSession(transaction, sessionHandle);
    const outcome = (ytuLink: YtuLinkCallbackStatus) => ({ ytuLink, session, returnTo: transaction.returnTo });
    if (callbackUrl.searchParams.has("error")) return outcome("error");
    const status = callbackUrl.searchParams.get("kc_action_status");
    if (
      callbackUrl.searchParams.get("kc_action") !== "idp_link" ||
      (status !== "success" && status !== "cancelled" && status !== "error")
    ) {
      return outcome("error");
    }
    let authorization;
    try {
      authorization = await this.protocol.exchange({
        callbackUrl,
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
    } catch {
      return outcome("error");
    }
    if (authorization.subject !== transaction.expectedSubject || !authorization.keycloakSid) {
      throw new InvalidOidcTransactionError();
    }
    await this.accountAccess.requireActive(authorization.subject);
    const currentTokens = await this.sessions.readTokens(session.id);
    if (!currentTokens) throw new InvalidOidcTransactionError();
    const replaced = await this.sessions.replaceTokens(
      session.id,
      currentTokens.version,
      authorization.tokens,
      authorization.keycloakSid,
    );
    return outcome(replaced ? status : "unverified");
  }

  async callback(
    callbackUrl: URL,
    browserBinding: string | undefined,
    sessionHandle?: string,
    requestId: string = randomUUID(),
  ) {
    const state = callbackUrl.searchParams.get("state");
    if (!state) throw new InvalidOidcTransactionError();
    const transaction = await this.transactions.consume(state, browserBinding);
    if (!transaction) throw new InvalidOidcTransactionError();

    if (transaction.purpose === "sudo-reauthentication") {
      return this.#sudoReauthenticationCallback(callbackUrl, transaction, sessionHandle);
    }
    if (transaction.purpose === "ytu-link") {
      return this.#ytuLinkCallback(callbackUrl, transaction, sessionHandle);
    }

    const authorization = await this.protocol.exchange({
      callbackUrl,
      state: transaction.state,
      nonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier,
    });
    if (authorization.sessionClaimIgnored) {
      // Before the session is created, so a login the fallback cap refuses still shows the cause.
      logAuthEvent({ event: "oidc_session_claims", requestId, outcome: "failure", reason: "session_claim_ignored" });
    }
    await this.accountAccess.requireActive(authorization.subject);
    const session = await this.sessions.create({
      subject: authorization.subject,
      keycloakSid: authorization.keycloakSid,
      authenticatedAt: authorization.authenticatedAt,
      // Keycloak's own session bounds; a Web handoff's session begins at the handoff, not at the app login.
      ...(authorization.upstreamSessionStartedAt
        ? { upstreamSessionStartedAt: authorization.upstreamSessionStartedAt }
        : {}),
      ...(authorization.upstreamSessionExpiresAt
        ? { upstreamSessionExpiresAt: authorization.upstreamSessionExpiresAt }
        : {}),
      tokens: authorization.tokens,
    });
    return {
      ...session,
      returnTo: transaction.returnTo,
      ...(authorization.embeddedApp ? { embeddedApp: authorization.embeddedApp } : {}),
    };
  }

  revokeRefreshToken(refreshToken: string) {
    return this.protocol.revokeRefreshToken(refreshToken);
  }
}
