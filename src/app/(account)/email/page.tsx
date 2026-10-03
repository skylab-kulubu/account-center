import { EmailManager } from "@/components/email-manager";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { isPrimaryEmailNudge } from "@/lib/primary-email-nudge";

const route = accountRoute("/email");

export const metadata = { title: route.documentTitle };

/**
 * Server-rendered shell; the addresses and every change run in the browser
 * against `/api/account/email*`: adding a Personal e-mail (Sudo mode, then
 * the six-digit code typed into this page), removing it (Sudo mode) and
 * choosing the Primary e-mail (Sudo mode). The sky-account SPI stays the
 * single place uniqueness and the proof rules are enforced.
 * `?intent=` is the K4c nudge followed from the home page; anything else is
 * ignored.
 */
export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { intent } = await searchParams;
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <EmailManager intent={isPrimaryEmailNudge(intent) ? intent : null} />
    </div>
  );
}
