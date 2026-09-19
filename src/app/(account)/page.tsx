import {
  CircleUserRound,
  KeyRound,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { PageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";

export default function OverviewPage() {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="SKY LAB"
        title="Hesabın, tek ve güvenli bir merkezde."
        description="Kimlik bilgilerini, giriş yöntemlerini ve açık oturumlarını buradan yönetebilirsin."
      />

      <section className="identity-card" aria-labelledby="identity-heading">
        <span className="identity-card__avatar" aria-hidden="true">
          <CircleUserRound size={27} strokeWidth={1.6} />
        </span>
        <span className="identity-card__copy">
          <span id="identity-heading">SKY LAB hesabı</span>
          <small>Hesap bilgileri güvenli oturum açıldıktan sonra gösterilecek.</small>
        </span>
        <StatusBadge>Bağlantı hazırlanıyor</StatusBadge>
      </section>

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
          <strong>Kimlik bilgilerin tarayıcıya kaydedilmez.</strong>
          <small>Hesap Merkezi güvenli, sunucu taraflı oturum kullanır.</small>
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
