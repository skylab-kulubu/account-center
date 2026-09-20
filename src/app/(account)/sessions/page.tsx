import { ShieldOff } from "lucide-react";
import { SessionManager } from "@/components/session-manager";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";

const route = accountRoute("/sessions");

export const metadata = { title: route.documentTitle };

export default function SessionsPage() {
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <SessionManager />
      <aside className="security-note">
        <ShieldOff aria-hidden="true" size={19} />
        <span>
          <strong>Tanımadığın bir oturumu hemen kapat.</strong>
          <small>İşlemler yalnız hesabına ait diğer oturumları etkiler; bu cihaz açık kalır.</small>
        </span>
      </aside>
    </div>
  );
}
