import { SecurityManager } from "@/components/security-manager";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";

const route = accountRoute("/security");

export const metadata = { title: route.documentTitle };

/**
 * Server-rendered shell; the credential inventory and every change run in
 * the browser against `/api/account/security/*` behind Sudo mode, so the
 * person never leaves `my.` for a password, passkey or verification-app
 * change.
 */
export default function SecurityPage() {
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <SecurityManager />
    </div>
  );
}
