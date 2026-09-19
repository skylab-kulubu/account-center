import { AlertTriangle, Check, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/settings";

export const metadata = { title: "Hesabı sil" };

const consequences = [
  "SKY LAB uygulamalarına erişimin hemen kapatılır.",
  "Açık oturumların ve giriş yöntemlerin geçersiz kılınır.",
  "Kişisel bilgilerin güvenli ve takip edilebilir bir işlemle silinir veya anonimleştirilir.",
  "Bilet, katılım ve verilmiş sertifika gibi zorunlu operasyon kayıtları kimliğinden ayrılarak korunabilir.",
];

export default function DeleteAccountPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Hesabı sil"
        description="Bu işlem geri alınamaz. Devam etmeden önce hesabına ve kayıtlarına ne olacağını açıkça göreceksin."
      />
      <section className="danger-card" aria-labelledby="delete-title">
        <span className="danger-card__icon" aria-hidden="true">
          <AlertTriangle size={23} />
        </span>
        <div>
          <h2 id="delete-title">Hesap silindiğinde</h2>
          <ul>
            {consequences.map((item) => (
              <li key={item}>
                <Check aria-hidden="true" size={16} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <button className="danger-button" type="button" disabled>
        <Trash2 aria-hidden="true" size={17} />
        Silme akışını başlat
      </button>
      <p className="page-hint">Silme akışı kimlik entegrasyonu ve yeniden doğrulama tamamlandıktan sonra etkinleşecek.</p>
    </div>
  );
}
