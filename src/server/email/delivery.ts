import "server-only";

import { shownUndeliverable } from "@/lib/email-delivery";
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

/** What SkyMail answered and the token it accepted (the refreshed one after a `401`). */
export type UndeliverableRead = { addresses: string[]; accessToken: string };

/**
 * The addresses SkyMail no longer mails for this person, read with the
 * session's own token like the inbox (`InboxService`): nothing is sent
 * without SkyMail configured or a token naming `skymail`, and a SkyMail 401
 * is retried once with a force-refreshed token. Every failure is an empty
 * list: the warning is advice and never in the way. Nothing is logged.
 * With `budgetMs`, an answer that takes longer is an empty list as well, so
 * a page that waits for it is never held up by SkyMail.
 */
export async function undeliverableAddresses(
  services: EmailDeliveryDependencies,
  session: SessionIdentity,
  accessToken: string,
  options: { budgetMs?: number } = {},
): Promise<UndeliverableRead> {
  const none: UndeliverableRead = { addresses: [], accessToken };
  const skymail = services.skymailEmailDelivery;
  if (!skymail || !namesSkyMail(accessToken)) return none;
  const read = (async (): Promise<UndeliverableRead> => {
    try {
      try {
        return { addresses: await skymail.undeliverableAddresses(accessToken), accessToken };
      } catch (error) {
        if (!(error instanceof SkyMailInboxError) || error.failure !== "unauthorized") throw error;
        const refreshed = await services.account.accessToken(session, { forceRefresh: true });
        return { addresses: await skymail.undeliverableAddresses(refreshed), accessToken: refreshed };
      }
    } catch {
      return none;
    }
  })();
  if (options.budgetMs === undefined) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<UndeliverableRead>((resolve) => {
    timer = setTimeout(() => resolve(none), options.budgetMs);
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
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
  view: Pick<EmailView, "email" | "primary" | "schoolEmail" | "personalEmail">,
): UndeliverableEmailKind[] {
  const listed = new Set(addresses.map((address) => normalized(address)));
  const own: Array<[UndeliverableEmailKind, string | null]> = [
    ["primary", normalized(view.email)],
    ["school", normalized(view.schoolEmail)],
    ["personal", normalized(view.personalEmail)],
  ];
  const kinds = own.filter(([, address]) => address !== null && address !== "" && listed.has(address)).map(([kind]) => kind);
  // Only what `/email` marks on a row: the overview and the page never disagree.
  return shownUndeliverable(view, kinds);
}
