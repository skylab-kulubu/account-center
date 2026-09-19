import { Laptop, MonitorSmartphone, ShieldOff, Smartphone } from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { PageHeader, StatusBadge } from "@/components/settings";
import { loadSessions } from "@/server/keycloak-account/page-data";

export const metadata = { title: "Oturumlar ve cihazlar" };

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

export default async function SessionsPage() {
  const data = await loadSessions();
  return (
    <div className="page-stack">
      <PageHeader
        title="Oturumlar ve cihazlar"
        description="Hesabının açık olduğu cihazları gör ve tanımadığın oturumların erişimini kaldır."
      />
      {data.ok ? (
        data.value.length > 0 ? (
          <section className="session-list" aria-label="Açık oturumlar">
            {data.value.map((session) => {
              const DeviceIcon = session.device?.mobile ? Smartphone : Laptop;
              const deviceName = [
                session.device?.name,
                session.device?.operatingSystem,
                session.device?.operatingSystemVersion,
              ].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ");
              return (
                <article className="session-card" key={session.id}>
                  <span className="session-card__icon" aria-hidden="true">
                    <DeviceIcon size={20} />
                  </span>
                  <span className="session-card__copy">
                    <strong>{deviceName || session.browser || "Bilinmeyen cihaz"}</strong>
                    <small>
                      {session.browser ? `${session.browser} · ` : ""}
                      Son erişim {dateFormatter.format(new Date(session.lastAccessAt))}
                    </small>
                  </span>
                  {session.current ? <StatusBadge tone="positive">Bu oturum</StatusBadge> : null}
                </article>
              );
            })}
          </section>
        ) : (
          <section className="state-card" aria-labelledby="sessions-state-title">
            <span className="state-card__icon" aria-hidden="true">
              <MonitorSmartphone size={26} strokeWidth={1.6} />
            </span>
            <h2 id="sessions-state-title">Açık oturum bulunamadı</h2>
            <p>Keycloak hesabın için görüntülenebilir aktif bir oturum bildirmedi.</p>
          </section>
        )
      ) : <AccountDataProblem problem={data.problem} retryHref="/sessions" />}
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
