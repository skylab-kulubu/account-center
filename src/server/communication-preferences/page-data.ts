import "server-only";

import { redirect } from "next/navigation";
import type { CommunicationPreferencesView } from "@/lib/communication-preferences";
import { currentAccountSession } from "@/server/access-gate/current-session";
import { getAuthServices } from "@/server/auth/services";
import { clubProfileServiceFor } from "@/server/club-profile/service";
import {
  communicationPreferencesDisabledProblem,
  toCommunicationPreferencesProblem,
} from "@/server/communication-preferences/problem";
import type { CommunicationPreferencesProblem } from "@/server/communication-preferences/problem";
import { communicationPreferencesServiceFor } from "@/server/communication-preferences/service";

export type CommunicationPreferencesState =
  | { status: "ready"; value: CommunicationPreferencesView }
  | { status: "problem"; problem: CommunicationPreferencesProblem };

export type CommunicationPreferencesPageData = {
  preferences: CommunicationPreferencesState;
  /** The Primary e-mail News goes to; `null` when core did not answer or there is none. */
  primaryEmail: string | null;
  csrfToken: string;
};

/**
 * Loads the preferences screen for the active session: core's screen and,
 * beside it, the Primary e-mail from core's `/v1/users/me` (the shadow of
 * the Keycloak address that the club profile shows too) for the "postalar
 * birincil adresine gider" line. The address is a hint only, so its failure
 * leaves the address out rather than failing the page.
 */
export async function loadCommunicationPreferencesPage(): Promise<CommunicationPreferencesPageData> {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value.session;
  const csrfToken = services.sessions.csrfToken(session.id);
  const service = communicationPreferencesServiceFor(services);
  const clubProfile = clubProfileServiceFor(services);

  const [screen, profile] = await Promise.allSettled([
    service ? service.read(session) : Promise.reject(null),
    clubProfile ? clubProfile.read(session) : Promise.reject(null),
  ]);
  const preferences: CommunicationPreferencesState = screen.status === "fulfilled"
    ? { status: "ready", value: screen.value }
    : {
        status: "problem",
        problem: service ? toCommunicationPreferencesProblem(screen.reason) : communicationPreferencesDisabledProblem,
      };
  const primaryEmail = profile.status === "fulfilled" ? profile.value.email : null;
  return { preferences, primaryEmail, csrfToken };
}
