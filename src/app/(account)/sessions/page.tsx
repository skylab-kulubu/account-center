import { MonitorSmartphone, ShieldOff } from "lucide-react";
import { PageHeader } from "@/components/settings";

export const metadata = { title: "Oturumlar ve cihazlar" };

export default function SessionsPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Oturumlar ve cihazlar"
        description="Hesabının açık olduğu cihazları gör ve tanımadığın oturumların erişimini kaldır."
      />
      <section className="state-card" aria-labelledby="sessions-state-title">
        <span className="state-card__icon" aria-hidden="true">
          <MonitorSmartphone size={26} strokeWidth={1.6} />
        </span>
        <h2 id="sessions-state-title">Oturum bilgileri henüz bağlı değil</h2>
        <p>Kimlik entegrasyonu tamamlandığında mevcut cihazın ve diğer açık oturumların burada görünecek.</p>
      </section>
      <aside className="security-note">
        <ShieldOff aria-hidden="true" size={19} />
        <span>
          <strong>Şüpheli bir oturum gördüğünde erişimi anında kaldırabileceksin.</strong>
          <small>Mevcut oturumu veya diğer tüm oturumları ayrı ayrı kapatmak mümkün olacak.</small>
        </span>
      </aside>
    </div>
  );
}
