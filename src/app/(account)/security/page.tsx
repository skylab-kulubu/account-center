import { Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { PageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { loadAuthentication } from "@/server/keycloak-account/page-data";

export const metadata = { title: "Giriş ve güvenlik" };

export default async function SecurityPage() {
  const data = await loadAuthentication();
  return (
    <div className="page-stack">
      <PageHeader
        title="Giriş ve güvenlik"
        description="Hesabına giriş yapma yöntemlerini ve ek güvenlik katmanlarını yönet."
      />
      {data.ok ? (
        <SettingsGroup title="Giriş yöntemleri">
          <SettingsRow
            icon={<KeyRound aria-hidden="true" size={19} />}
            title="Şifre"
            description="Şifreni güvenli kimlik doğrulama adımında değiştirebilirsin."
            trailing={<StatusBadge tone={data.value.passwordConfigured ? "positive" : "warning"}>
              {data.value.passwordConfigured ? "Ayarlı" : "Ayarlı değil"}
            </StatusBadge>}
          />
          <SettingsRow
            icon={<Fingerprint aria-hidden="true" size={19} />}
            title="Passkey’ler"
            description="Cihazını kullanarak daha hızlı ve güvenli giriş yap."
            trailing={<StatusBadge tone={data.value.passkeyCount > 0 ? "positive" : "warning"}>
              {data.value.passkeyCount > 0 ? `${data.value.passkeyCount} passkey` : "Ayarlı değil"}
            </StatusBadge>}
          />
          <SettingsRow
            icon={<ShieldCheck aria-hidden="true" size={19} />}
            title="İki adımlı doğrulama"
            description="Doğrulama uygulamasıyla hesabına ek koruma ekle."
            trailing={<StatusBadge tone={data.value.otpConfigured ? "positive" : "warning"}>
              {data.value.otpConfigured ? "Ayarlı" : "Ayarlı değil"}
            </StatusBadge>}
          />
        </SettingsGroup>
      ) : <AccountDataProblem problem={data.problem} retryHref="/security" />}
      <p className="page-hint">
        Güvenlik değişiklikleri, işlem öncesinde kimliğini yeniden doğrulamanı isteyecek.
      </p>
    </div>
  );
}
