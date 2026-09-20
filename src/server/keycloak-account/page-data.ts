import "server-only";

import { redirect } from "next/navigation";
import { getAuthServices } from "@/server/auth/services";
import { currentAccountSession } from "@/server/access-gate/current-session";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import type {
  AccountOverview,
  AccountProfile,
  AccountSecurity,
  AccountSession,
  AuthenticationSummary,
} from "@/server/keycloak-account/types";
import type { AccountActionResult } from "@/server/auth/types";

export type AccountPageData<T> =
  | { ok: true; value: T }
  | { ok: false; problem: AccountProblem };

type SecurityPageData =
  | {
      ok: true;
      value: AccountSecurity & {
        actionCsrfToken: string;
        actionResult: AccountActionResult | null;
      };
    }
  | {
      ok: false;
      problem: AccountProblem;
      actionResult: AccountActionResult | null;
    };

async function load<T>(
  select: (
    services: ReturnType<typeof getAuthServices>,
    session: { id: string; subject: string },
  ) => Promise<T>,
): Promise<AccountPageData<T>> {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  try {
    return { ok: true, value: await select(services, authorization.value.session) };
  } catch (error) {
    return { ok: false, problem: toAccountProblem(error) };
  }
}

export function loadOverview(): Promise<AccountPageData<AccountOverview>> {
  return load((services, session) => services.account.overview(session));
}

export function loadProfile(): Promise<AccountPageData<AccountProfile>> {
  return load((services, session) => services.account.profile(session));
}

export function loadAuthentication(): Promise<AccountPageData<AuthenticationSummary>> {
  return load((services, session) => services.account.authentication(session));
}

export function loadSecurity(
  resultReference?: string,
): Promise<SecurityPageData> {
  return (async () => {
    const services = getAuthServices();
    const authorization = await currentAccountSession();
    if (authorization.status === "blocked") redirect("/api/auth/session/end");
    if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
    if (authorization.status !== "active") redirect("/login");
    const session = authorization.value.session;
    const actionResult = await services.actionResults
      .consume(resultReference, session.id)
      .catch(() => null);
    try {
      const security = await services.account.security(session);
      return {
        ok: true as const,
        value: {
          ...security,
          actionCsrfToken: services.sessions.csrfToken(session.id),
          actionResult,
        },
      };
    } catch (error) {
      return { ok: false as const, problem: toAccountProblem(error), actionResult };
    }
  })();
}

export function loadSessions(): Promise<AccountPageData<AccountSession[]>> {
  return load((services, session) => services.account.sessionsList(session));
}
