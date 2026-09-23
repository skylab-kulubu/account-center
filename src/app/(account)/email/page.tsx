import { EmailManager } from "@/components/email-manager";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";

const route = accountRoute("/email");

export const metadata = { title: route.documentTitle };

/**
 * Server-rendered shell; the addresses and every change run in the browser
 * against `/api/account/email*`: adding a Personal e-mail (Sudo mode, then
 * the six-digit code typed into this page), removing it (Sudo mode) and
 * choosing the Primary e-mail (Sudo mode). The sky-account SPI stays the
 * single place uniqueness and the proof rules are enforced.
 */
export default function EmailPage() {
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <EmailManager />
    </div>
  );
}
