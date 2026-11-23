import "server-only";

import { currentAccountSession } from "@/server/access-gate/current-session";
import { getAuthServices } from "@/server/auth/services";
import { readCurrentCoreProfile } from "@/server/club-profile/current-profile";

/** Who the account menu shows: the same person the overview and the club profile show. */
export type ShellIdentity = {
  name: string | null;
  email: string | null;
  pictureUrl: string | null;
};

function fullName(firstName: string | null, lastName: string | null, username: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ") || username || null;
}

/**
 * The signed-in person for the account menu at the top right. Core's profile
 * first, as the club-profile page reads it (the name and primary e-mail core
 * keeps in step with Keycloak, and the profile photo); the read is shared with
 * that page, so it costs no second call there. Without core, or when it
 * fails, the name and e-mail come from Keycloak Account REST. Null when
 * neither answers: the menu still opens and signs out.
 */
export async function loadShellIdentity(): Promise<ShellIdentity | null> {
  const authorization = await currentAccountSession();
  if (authorization.status !== "active") return null;
  const session = authorization.value.session;
  const services = getAuthServices();
  try {
    const core = await readCurrentCoreProfile(services, session);
    if (core) {
      return {
        name: fullName(core.firstName, core.lastName, core.username),
        email: core.email,
        pictureUrl: core.profilePictureUrl,
      };
    }
  } catch {
    // Keycloak below; the club-profile page reports core's problem itself
  }
  try {
    const profile = await services.account.profile(session);
    return { name: fullName(profile.firstName, profile.lastName, profile.username), email: profile.email, pictureUrl: null };
  } catch {
    return null;
  }
}
