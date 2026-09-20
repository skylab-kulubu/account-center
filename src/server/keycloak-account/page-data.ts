import "server-only";

import { redirect } from "next/navigation";
import { getAuthServices } from "@/server/auth/services";
import { currentAccountSession } from "@/server/access-gate/current-session";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import type {
  AccountOverview,
  AccountProfile,
  AccountSession,
  AuthenticationSummary,
} from "@/server/keycloak-account/types";

export type AccountPageData<T> =
  | { ok: true; value: T }
  | { ok: false; problem: AccountProblem };

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

export function loadSessions(): Promise<AccountPageData<AccountSession[]>> {
  return load((services, session) => services.account.sessionsList(session));
}
