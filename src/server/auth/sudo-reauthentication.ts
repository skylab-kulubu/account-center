import "server-only";

import { logAuthEvent } from "@/server/auth/logging";
import type { getAuthServices } from "@/server/auth/services";
import type { ActiveSession } from "@/server/auth/types";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { SkyAccountProblem, SkyAccountUnavailableError } from "@/server/sky-account/client";
import type { SudoGrant } from "@/server/sky-account/client";

type Services = ReturnType<typeof getAuthServices>;

/** What the page learns from `?sudo=`; `cancelled` is decided before this step. */
export type SudoReauthenticationOutcome = "confirmed" | "unavailable";

/**
 * Why the fresh login did not become a sudo token. Fixed, non-identifying
 * reasons: `stale` (the login is older than the SPI's five-minute window),
 * `refused` (the SPI rejected the proof), `unavailable` (the extension or the
 * session's bearer could not be reached) and `contract` (an answer outside
 * the pinned contract). The ID token itself never reaches a log line.
 */
type AuthenticationFailure = "stale" | "refused" | "unavailable" | "contract";

function authenticationFailure(error: unknown): AuthenticationFailure {
  if (error instanceof SkyAccountProblem) {
    return error.code === "authentication_stale" ? "stale" : "refused";
  }
  if (error instanceof SkyAccountUnavailableError) return "unavailable";
  if (error instanceof AccountReauthenticationRequiredError) return "unavailable";
  return "contract";
}

/**
 * Finishes Sudo mode's Microsoft fallback. The callback has just verified the
 * round trip (`auth_time`, `sid`, `sub`) and stored the fresh token set, so
 * the BFF holds an ID token that proves the login. It is offered once to
 * sky-account `POST sudo/authentication` with the session's own access token
 * as bearer; the returned grant is kept as a `reauth` proof with the SPI's
 * deadline (`auth_time + 300`, still bounded by the local maximum) and is
 * what later `X-Sky-Sudo` calls present.
 *
 * A refusal is not the end of the round trip: the person *is*
 * re-authenticated, so the token-less proof is written instead and the page
 * still hears `confirmed`; a mutation that needs SPI material then answers
 * `428 spi_token_required` and the page explains it. Only material that
 * cannot be stored at all (the session is gone) becomes `unavailable`.
 *
 * The ID token is used here and nowhere else: it is never stored by this
 * function, never logged and never written to the answer.
 */
export async function completeSudoReauthentication(
  services: Pick<Services, "account" | "skyAccount" | "sudo">,
  session: ActiveSession,
  proof: { authenticatedAt: Date; idToken: string },
  requestId: string,
): Promise<SudoReauthenticationOutcome> {
  let grant: SudoGrant | null = null;
  try {
    const accessToken = await services.account.accessToken(session);
    grant = await services.skyAccount.sudoAuthentication({ accessToken }, { idToken: proof.idToken });
  } catch (error) {
    logAuthEvent({
      event: "sudo_authentication_failed",
      requestId,
      outcome: "failure",
      reason: authenticationFailure(error),
      sudoMethod: "reauth",
    });
  }

  let stored = false;
  if (grant) {
    try {
      await services.sudo.storeSudo(session.id, grant.sudoToken, grant.expiresAt, "reauth");
      stored = true;
    } catch {
      // The grant could not be kept (inactive session, a deadline already past):
      // the token-less proof below still records that the person re-authenticated.
    }
  }
  if (!stored) {
    try {
      await services.sudo.storeReauthenticationProof(session.id, proof.authenticatedAt);
    } catch {
      logAuthEvent({
        event: "sudo_reauthentication_completed",
        requestId,
        outcome: "failure",
        reason: "sudo_storage_failed",
        sudoMethod: "reauth",
      });
      return "unavailable";
    }
  }
  logAuthEvent({
    event: "sudo_reauthentication_completed",
    requestId,
    outcome: "success",
    sudoMethod: "reauth",
  });
  return "confirmed";
}
