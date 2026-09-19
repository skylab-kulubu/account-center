import { Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { PageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";

export const metadata = { title: "Giriş ve güvenlik" };

export default function SecurityPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Giriş ve güvenlik"
        description="Hesabına giriş yapma yöntemlerini ve ek güvenlik katmanlarını yönet."
      />
      <SettingsGroup title="Giriş yöntemleri">
        <SettingsRow
          icon={<KeyRound aria-hidden="true" size={19} />}
          title="Şifre"
          description="Şifreni güvenli kimlik doğrulama adımında değiştir."
          trailing={<StatusBadge>Yakında</StatusBadge>}
        />
        <SettingsRow
          icon={<Fingerprint aria-hidden="true" size={19} />}
          title="Passkey’ler"
          description="Cihazını kullanarak daha hızlı ve güvenli giriş yap."
          trailing={<StatusBadge>Yakında</StatusBadge>}
        />
        <SettingsRow
          icon={<ShieldCheck aria-hidden="true" size={19} />}
          title="İki adımlı doğrulama"
          description="Doğrulama uygulamasıyla hesabına ek koruma ekle."
          trailing={<StatusBadge>Yakında</StatusBadge>}
        />
      </SettingsGroup>
      <p className="page-hint">
        Güvenlik değişiklikleri, işlem öncesinde kimliğini yeniden doğrulamanı isteyecek.
      </p>
    </div>
  );
}
