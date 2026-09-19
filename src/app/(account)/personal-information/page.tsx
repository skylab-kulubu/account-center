import { AtSign, UserRound } from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { PageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { loadProfile } from "@/server/keycloak-account/page-data";

export const metadata = { title: "Kişisel bilgiler" };

export default async function PersonalInformationPage() {
  const data = await loadProfile();
  return (
    <div className="page-stack">
      <PageHeader
        title="Kişisel bilgiler"
        description="SKY LAB kimliğinde kullanılan temel bilgileri görüntüle ve yönet."
      />
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
      <p className="page-hint">
        Üniversite, bölüm, kulüp rolleri ve üyelik bilgileri Hesap Merkezi kapsamına dahil değildir.
      </p>
    </div>
  );
}
