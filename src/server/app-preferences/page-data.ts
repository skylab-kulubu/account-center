import "server-only";

import { redirect } from "next/navigation";
import type { AppPreferenceSummary } from "@/lib/app-preferences";
import { currentAccountSession } from "@/server/access-gate/current-session";
import { toAppPreferencesProblem } from "@/server/app-preferences/http";
import { appPreferencesServiceFor } from "@/server/app-preferences/service";
import { getAuthServices } from "@/server/auth/services";
import type { AccountProblem } from "@/server/keycloak-account/problem";

export type AppPreferencesPageData = {
  summary: { status: "ready"; items: AppPreferenceSummary[] } | { status: "problem"; problem: AccountProblem };
  csrfToken: string;
};

/**
 * The "Uygulama ayarları" page for the active session: core's summary.
 * Without `CORE_API_URL`, or while core has the feature off, the list is
 * empty ("Kayıtlı ayar yok."): there is nothing to show or reset.
 */
export async function loadAppPreferencesPage(): Promise<AppPreferencesPageData> {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value.session;
  const csrfToken = services.sessions.csrfToken(session.id);
  const service = appPreferencesServiceFor(services);
  if (!service) return { summary: { status: "ready", items: [] }, csrfToken };
  try {
    return { summary: { status: "ready", items: await service.summary(session) }, csrfToken };
  } catch (error) {
    return { summary: { status: "problem", problem: toAppPreferencesProblem(error) }, csrfToken };
  }
}
