import {
  CircleUserRound,
  KeyRound,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { AccountPageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadOverview } from "@/server/keycloak-account/page-data";

const route = accountRoute("/");

export const metadata = { title: route.documentTitle };

export default async function OverviewPage() {
  const data = await loadOverview();
  const displayName = data.ok
    ? [data.value.profile.firstName, data.value.profile.lastName].filter(Boolean).join(" ") || "SKY LAB hesabı"
    : null;
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />

      {data.ok ? (
        <section className="identity-card" aria-labelledby="identity-heading">
          <span className="identity-card__avatar" aria-hidden="true">
            <CircleUserRound size={27} strokeWidth={1.6} />
          </span>
          <span className="identity-card__copy">
            <span id="identity-heading">{displayName}</span>
            <small>{data.value.profile.email ?? "Birincil e-posta tanımlı değil"}</small>
          </span>
          <StatusBadge tone={data.value.profile.emailVerified ? "positive" : "warning"}>
            {data.value.profile.emailVerified ? "E-posta doğrulandı" : "E-posta doğrulanmadı"}
          </StatusBadge>
        </section>
      ) : <AccountDataProblem problem={data.problem} retryHref="/" />}

      <SettingsGroup title="Hesap ayarları" description="En sık kullanılan hesap ve güvenlik alanları.">
        <SettingsRow
          href="/personal-information"
          icon={<CircleUserRound aria-hidden="true" size={19} />}
          title="Kişisel bilgiler"
          description="Adını ve birincil e-posta adresini görüntüle."
        />
        <SettingsRow
          href="/security"
          icon={<KeyRound aria-hidden="true" size={19} />}
          title="Giriş ve güvenlik"
          description="Şifre, passkey ve iki adımlı doğrulama."
        />
        <SettingsRow
          href="/sessions"
          icon={<MonitorSmartphone aria-hidden="true" size={19} />}
          title="Oturumlar ve cihazlar"
          description="Hesabının açık olduğu cihazları denetle."
        />
      </SettingsGroup>

      <aside className="security-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <span>
          <strong>
            {data.ok && !data.value.authentication.otpConfigured && data.value.authentication.passkeyCount === 0
              ? "Hesabına ek bir giriş yöntemi eklemeni öneriyoruz."
              : "Kimlik bilgilerin tarayıcıya kaydedilmez."}
          </strong>
          <small>
            {data.ok && !data.value.authentication.otpConfigured && data.value.authentication.passkeyCount === 0
              ? "Bir passkey veya iki adımlı doğrulama hesabının güvenliğini artırır."
              : "Hesap Merkezi güvenli, sunucu taraflı oturum kullanır."}
          </small>
        </span>
      </aside>

      <SettingsGroup title="Hesap yönetimi">
        <SettingsRow
          href="/delete-account"
          icon={<Trash2 aria-hidden="true" size={19} />}
          title="Hesabı sil"
          description="Kalıcı silme sürecini ve sonuçlarını incele."
          tone="danger"
        />
      </SettingsGroup>
    </div>
  );
}
