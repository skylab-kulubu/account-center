import "server-only";

import type { UndeliverableEmailKind } from "@/lib/email-delivery";
import type { EmailView } from "@/server/email/view";
import { namesSkyMail } from "@/server/inbox/service";
import type { AccountReadService } from "@/server/keycloak-account/service";
import { SkyMailInboxError } from "@/server/skymail/inbox-client";
import type { SkyMailEmailDeliveryClient } from "@/server/skymail/inbox-client";

type SessionIdentity = { id: string; subject: string };

export type EmailDeliveryDependencies = {
  account: Pick<AccountReadService, "accessToken">;
  /** `null` when `SKYMAIL_API_URL` is unset. */
  skymailEmailDelivery?: SkyMailEmailDeliveryClient | null;
};

/**
 * The addresses SkyMail no longer mails for this person, read with the
 * session's own token like the inbox (`InboxService`): nothing is sent
 * without SkyMail configured or a token naming `skymail`, and a SkyMail 401
 * is retried once with a force-refreshed token. Every failure is an empty
 * list: the warning is advice and never in the way. Nothing is logged.
 */
export async function undeliverableAddresses(
  services: EmailDeliveryDependencies,
  session: SessionIdentity,
  accessToken: string,
): Promise<string[]> {
  const skymail = services.skymailEmailDelivery;
  if (!skymail || !namesSkyMail(accessToken)) return [];
  try {
    try {
      return await skymail.undeliverableAddresses(accessToken);
    } catch (error) {
      if (!(error instanceof SkyMailInboxError) || error.failure !== "unauthorized") throw error;
      return await skymail.undeliverableAddresses(await services.account.accessToken(session, { forceRefresh: true }));
    }
  } catch {
    return [];
  }
}

function normalized(address: string | null) {
  return address === null ? null : address.trim().toLowerCase();
}

/**
 * Which of the person's own addresses the list names, compared trimmed and
 * lower-cased. One address may be several kinds (the Primary e-mail is
 * usually the School e-mail). An address that is none of the three is ignored.
 */
export function undeliverableKinds(
  addresses: readonly string[],
  view: Pick<EmailView, "email" | "schoolEmail" | "personalEmail">,
): UndeliverableEmailKind[] {
  const listed = new Set(addresses.map((address) => normalized(address)));
  const own: Array<[UndeliverableEmailKind, string | null]> = [
    ["primary", normalized(view.email)],
    ["school", normalized(view.schoolEmail)],
    ["personal", normalized(view.personalEmail)],
  ];
  return own.filter(([, address]) => address !== null && address !== "" && listed.has(address)).map(([kind]) => kind);
}
