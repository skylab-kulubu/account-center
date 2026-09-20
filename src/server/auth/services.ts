import "server-only";

import { AesGcmSecretCipher } from "@/server/auth/crypto";
import {
  BackchannelLogoutService,
  KeycloakBackchannelLogoutVerifier,
} from "@/server/auth/backchannel-logout";
import { getAuthConfig } from "@/server/auth/config";
import { OidcFlowService } from "@/server/auth/oidc-flow";
import { OAuth4WebApiProtocol } from "@/server/auth/oidc-protocol";
import { OidcTransactionStore } from "@/server/auth/oidc-transactions";
import {
  PostgresOidcTransactionRepository,
  PostgresBackchannelLogoutRepository,
  PostgresRateLimitRepository,
  PostgresSessionRepository,
  PostgresNativeHandoffRepository,
} from "@/server/auth/postgres-repositories";
import { AnonymousAuthRateLimiter } from "@/server/auth/rate-limit";
import { SessionManager } from "@/server/auth/sessions";
import { getDatabasePool } from "@/server/db/pool";
import { Keycloak26AccountReadAdapter } from "@/server/keycloak-account/adapter";
import { AccountReadService } from "@/server/keycloak-account/service";
import { NativeHandoffService } from "@/server/auth/native-handoff";
import { createNativeAccessTokenVerifier } from "@/server/auth/native-handoff-token";
import { NativeBridgeRequestVerifier } from "@/server/auth/native-bridge-auth";
import { getAccountAccessGateConfig } from "@/server/access-gate/config";
import { createAccountAccessGate } from "@/server/access-gate/gate";
import { AccountAccessAuthorizer } from "@/server/access-gate/authorization";
import { AccountSessionAccess } from "@/server/access-gate/session-access";

type AuthServices = ReturnType<typeof createAuthServices>;
const globalServices = globalThis as typeof globalThis & { accountCenterAuthServices?: AuthServices };

function createAuthServices() {
  const config = getAuthConfig();
  const pool = getDatabasePool();
  const cipher = new AesGcmSecretCipher(config.tokenEncryptionKey);
  const protocol = new OAuth4WebApiProtocol(config);
  const sessions = new SessionManager(
    new PostgresSessionRepository(pool),
    cipher,
    config.sessionHmacKey,
    {
      absoluteTtlSeconds: config.sessionAbsoluteTtlSeconds,
      upstreamSessionMaxSeconds: config.upstreamSessionMaxSeconds,
      idleTtlSeconds: config.sessionIdleTtlSeconds,
      rotationSeconds: config.sessionRotationSeconds,
      previousHandleGraceSeconds: config.previousHandleGraceSeconds,
    },
  );
  const accountAccess = new AccountAccessAuthorizer(
    createAccountAccessGate(getAccountAccessGateConfig(config.issuer)),
    sessions,
  );
  const sessionAccess = new AccountSessionAccess(sessions, accountAccess);
  const transactions = new OidcTransactionStore(
    new PostgresOidcTransactionRepository(pool),
    cipher,
    config.oidcTransactionTtlSeconds,
  );
  const oidc = new OidcFlowService(protocol, transactions, sessions, accountAccess);
  const nativeHandoff = new NativeHandoffService(
    createNativeAccessTokenVerifier(config.issuer),
    new PostgresNativeHandoffRepository(pool),
    oidc,
    accountAccess,
    config.appUrl,
  );
  return {
    config,
    sessions,
    sessionAccess,
    accountAccess,
    oidc,
    account: new AccountReadService(
      new Keycloak26AccountReadAdapter(config.issuer),
      sessions,
      protocol,
      { issuer: config.issuer, clientId: config.clientId },
    ),
    nativeHandoff,
    nativeBridgeRequest: new NativeBridgeRequestVerifier(
      config.nativeBridgeHmacSecret,
      config.nativeBridgeMtlsClientSha256,
    ),
    backchannelLogout: new BackchannelLogoutService(
      new KeycloakBackchannelLogoutVerifier(config),
      new PostgresBackchannelLogoutRepository(pool),
      config.sessionHmacKey,
    ),
    anonymousRateLimit: new AnonymousAuthRateLimiter(
      new PostgresRateLimitRepository(pool),
      config.sessionHmacKey,
      config.trustedProxy,
    ),
  };
}

export function getAuthServices() {
  globalServices.accountCenterAuthServices ??= createAuthServices();
  return globalServices.accountCenterAuthServices;
}
