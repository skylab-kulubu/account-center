import { ShieldOff } from "lucide-react";
import { SessionManager } from "@/components/session-manager";
import { PageHeader } from "@/components/settings";

export const metadata = { title: "Oturumlar ve cihazlar" };

export default function SessionsPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Oturumlar ve cihazlar"
        description="Hesabının açık olduğu cihazları gör ve tanımadığın oturumların erişimini kaldır."
      />
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
