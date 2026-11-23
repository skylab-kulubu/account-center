import { SessionManager } from "@/components/session-manager";
import { accountRoute } from "@/config/account-routes";
import { AccountPageHeader } from "@/components/settings";

const route = accountRoute("/sessions");

export const metadata = { title: route.documentTitle };

export default function SessionsPage() {
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <SessionManager />
    </div>
  );
}
