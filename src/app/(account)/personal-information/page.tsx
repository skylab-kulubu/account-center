import { AtSign, UserRound } from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { AccountPageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadProfile } from "@/server/keycloak-account/page-data";

const route = accountRoute("/personal-information");

export const metadata = { title: route.documentTitle };

export default async function PersonalInformationPage() {
  const data = await loadProfile();
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      {data.ok ? (
        <SettingsGroup title="Kimlik bilgileri" description="Bu alanlar merkezi SKY LAB kimliğine bağlıdır.">
          <SettingsRow
            icon={<UserRound aria-hidden="true" size={19} />}
            title="Ad soyad"
            description={[data.value.firstName, data.value.lastName].filter(Boolean).join(" ") || "Tanımlı değil"}
            trailing={<StatusBadge>Keycloak</StatusBadge>}
          />
          <SettingsRow
            icon={<AtSign aria-hidden="true" size={19} />}
            title="E-posta"
            description={data.value.email ?? "Tanımlı değil"}
            trailing={
              <StatusBadge tone={data.value.emailVerified ? "positive" : "warning"}>
                {data.value.emailVerified ? "Doğrulandı" : "Doğrulanmadı"}
              </StatusBadge>
            }
          />
        </SettingsGroup>
      ) : <AccountDataProblem problem={data.problem} retryHref="/personal-information" />}
      <aside className="read-only-note" aria-label="Bilgileri değiştirme">
        Bu bilgiler salt okunurdur. Bir düzeltme gerekiyorsa SKY LAB yönetim ekibiyle iletişime geç.
      </aside>
    </div>
  );
}
