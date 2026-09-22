import "server-only";

import { redirect } from "next/navigation";
import { currentAccountSession } from "@/server/access-gate/current-session";
import { getAuthServices } from "@/server/auth/services";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import type { AccountGroup } from "@/server/keycloak-account/types";
import { buildPermissionsViewModel } from "@/server/permissions/view-model";
import type { PermissionsViewModel } from "@/server/permissions/view-model";

export type PermissionsPageData =
  | {
      ok: true;
      value: PermissionsViewModel;
      /** Set when Account REST groups could not be read; the token-derived application permissions still render. */
      teamsProblem: AccountProblem | null;
    }
  | { ok: false; problem: AccountProblem };

/**
 * Reads the two sources of the Permissions view for the active session. The
 * `sky_authorization` claim comes from the server-held token and decides
 * whether the page can render at all; the groups read is a separate upstream
 * call whose failure degrades the page to a banner instead of blocking it,
 * unless it demands a fresh login.
 */
export async function loadPermissions(): Promise<PermissionsPageData> {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value.session;

  let skyAuthorization;
  try {
    skyAuthorization = await services.account.authorization(session);
  } catch (error) {
    return { ok: false, problem: toAccountProblem(error) };
  }

  let groups: readonly AccountGroup[] = [];
  let teamsProblem: AccountProblem | null = null;
  try {
    groups = await services.account.groups(session);
  } catch (error) {
    const problem = toAccountProblem(error);
    if (problem.status === 401) return { ok: false, problem };
    teamsProblem = problem;
  }

  return {
    ok: true,
    value: buildPermissionsViewModel({ groups, authorization: skyAuthorization }),
    teamsProblem,
  };
}
