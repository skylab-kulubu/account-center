import { IdentityManager } from "@/components/identity-manager";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";

const route = accountRoute("/identity");

export const metadata = { title: route.documentTitle };

/**
 * Server-rendered shell; the identity (name, username, YTÜ status, e-mail
 * rows) and every change run in the browser against `/api/account/identity*`
 * so the sky-account SPI stays the single place the Verified YTÜ lock, the
 * username uniqueness and the 14-day cooldown are enforced.
 */
export default function IdentityPage() {
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <IdentityManager />
    </div>
  );
}
