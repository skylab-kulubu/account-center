import "server-only";

import { redirect } from "next/navigation";
import { currentAccountSession } from "@/server/access-gate/current-session";
import { getAuthServices } from "@/server/auth/services";
import { toClubProfileProblem } from "@/server/club-profile/problem";
import type { ClubProfileProblem } from "@/server/club-profile/problem";
import { clubProfileServiceFor, toClubProfileView } from "@/server/club-profile/service";
import type { ClubProfileView } from "@/server/club-profile/service";
import type { CoreProfile } from "@/server/core/profile-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import type { AccountProfile } from "@/server/keycloak-account/types";

export type ClubProfileState =
  | { status: "ready"; value: ClubProfileView }
  /** `CORE_API_URL` is unset: club-profile features are off in this environment. */
  | { status: "disabled" }
  | { status: "problem"; problem: ClubProfileProblem };

/** The identity summary shown above the club fields: name, primary e-mail and the YTÜ-derived values. */
export type ClubProfileIdentity = {
  displayName: string | null;
  email: string | null;
  schoolEmail: string | null;
  skyNumber: string | null;
};

export type ClubProfilePageData = {
  identity: { ok: true; value: ClubProfileIdentity } | { ok: false; problem: AccountProblem };
  clubProfile: ClubProfileState;
  csrfToken: string;
};

function identityFromCore(profile: CoreProfile): ClubProfileIdentity {
  return {
    displayName: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null,
    email: profile.email,
    schoolEmail: profile.schoolEmail,
    skyNumber: profile.skyNumber,
  };
}

function identityFromKeycloak(profile: AccountProfile): ClubProfileIdentity {
  return {
    displayName: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null,
    email: profile.email,
    schoolEmail: profile.attributes.schoolEmail,
    skyNumber: profile.attributes.skyNumber,
  };
}

/**
 * Loads the club-profile page for the active session. The core profile is
 * the primary source: it carries the club fields and the shadow of the
 * Keycloak identity (name, primary and school e-mail, skyNumber) that core
 * keeps in step with Keycloak, so a healthy page costs one upstream call.
 * When core is off or fails, the identity summary is read from Keycloak
 * Account REST instead so the page still shows who the person is next to
 * the club-profile banner.
 */
export async function loadClubProfilePage(): Promise<ClubProfilePageData> {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value.session;
  const csrfToken = services.sessions.csrfToken(session.id);
  const clubProfileService = clubProfileServiceFor(services);

  let clubProfile: ClubProfileState = { status: "disabled" };
  if (clubProfileService) {
    try {
      const profile = await clubProfileService.read(session);
      return {
        identity: { ok: true, value: identityFromCore(profile) },
        clubProfile: { status: "ready", value: toClubProfileView(profile) },
        csrfToken,
      };
    } catch (error) {
      clubProfile = { status: "problem", problem: toClubProfileProblem(error) };
    }
  }

  let identity: ClubProfilePageData["identity"];
  try {
    identity = { ok: true, value: identityFromKeycloak(await services.account.profile(session)) };
  } catch (error) {
    identity = { ok: false, problem: toAccountProblem(error) };
  }
  return { identity, clubProfile, csrfToken };
}
