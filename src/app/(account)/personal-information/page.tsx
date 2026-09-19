import { AtSign, UserRound } from "lucide-react";
import { PageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";

export const metadata = { title: "Kişisel bilgiler" };

export default function PersonalInformationPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Kişisel bilgiler"
        description="SKY LAB kimliğinde kullanılan temel bilgileri görüntüle ve yönet."
      />
      <SettingsGroup title="Kimlik bilgileri" description="Bu alanlar merkezi SKY LAB kimliğine bağlıdır.">
        <SettingsRow
          icon={<UserRound aria-hidden="true" size={19} />}
          title="Ad soyad"
          description="Oturum açıldığında kimlik sağlayıcısından alınır."
          trailing={<StatusBadge>Bekleniyor</StatusBadge>}
        />
        <SettingsRow
          icon={<AtSign aria-hidden="true" size={19} />}
          title="E-posta"
          description="Birincil e-posta adresin oturum açıldığında gösterilir."
          trailing={<StatusBadge>Bekleniyor</StatusBadge>}
        />
      </SettingsGroup>
      <p className="page-hint">
        Üniversite, bölüm, kulüp rolleri ve üyelik bilgileri Hesap Merkezi kapsamına dahil değildir.
      </p>
    </div>
  );
}
