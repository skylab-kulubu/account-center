import { AlertTriangle, Check } from "lucide-react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/settings";
import { AccountDeletionConfirmation } from "@/components/account-deletion-confirmation";
import { ACCOUNT_DELETION_PROOF_COOKIE } from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";
import { currentAccountSession } from "@/server/access-gate/current-session";

export const metadata = { title: "Hesabı sil" };

const consequences = [
  "SKY LAB uygulamalarına erişimin hemen kapatılır.",
  "Açık oturumların ve giriş yöntemlerin geçersiz kılınır.",
  "Kişisel bilgilerin güvenli ve takip edilebilir bir işlemle silinir veya anonimleştirilir.",
  "Bilet, katılım ve verilmiş sertifika gibi zorunlu operasyon kayıtları kimliğinden ayrılarak korunabilir.",
];

export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status !== "active") redirect("/login");
  const parameters = await searchParams;
  const deletionError = parameters.deletionError === "proof_expired" ||
    parameters.deletionError === "reauth_unavailable" ||
    parameters.deletionError === "deletion_unavailable"
    ? parameters.deletionError
    : undefined;
  const proof = (await cookies()).get(ACCOUNT_DELETION_PROOF_COOKIE)?.value;
  const reauthenticated = typeof proof === "string" && /^[A-Za-z0-9_-]{43}$/.test(proof);
  const csrfToken = services.sessions.csrfToken(authorization.value.session.id);
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
      <AccountDeletionConfirmation
        csrfToken={csrfToken}
        deletionError={deletionError}
        enabled={services.accountDeletion !== null}
        reauthenticated={reauthenticated}
        reauthenticationCancelled={parameters.reauth === "cancelled"}
      />
      <p className="page-hint">Silme isteğin kabul edildiğinde tüm Hesap Merkezi oturumların kapatılır ve durum takibi bu tarayıcıda güvenli bir yetkiyle devam eder.</p>
    </div>
  );
}
