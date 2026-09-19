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
} from "@/server/auth/postgres-repositories";
import { AnonymousAuthRateLimiter } from "@/server/auth/rate-limit";
import { SessionManager } from "@/server/auth/sessions";
import { getDatabasePool } from "@/server/db/pool";
import { Keycloak26AccountReadAdapter } from "@/server/keycloak-account/adapter";
import { AccountReadService } from "@/server/keycloak-account/service";

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
  const transactions = new OidcTransactionStore(
    new PostgresOidcTransactionRepository(pool),
    cipher,
    config.oidcTransactionTtlSeconds,
  );
  return {
    config,
    sessions,
    oidc: new OidcFlowService(protocol, transactions, sessions),
    account: new AccountReadService(
      new Keycloak26AccountReadAdapter(config.issuer),
      sessions,
      protocol,
      { issuer: config.issuer, clientId: config.clientId },
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
